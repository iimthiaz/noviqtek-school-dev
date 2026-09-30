import { HttpError, forbidden, newId, nowIso, sha256Hex, hmacHex, randomToken, timingSafeEqual } from './util.js';

const enc = new TextEncoder();
const PBKDF2_ITER = 100000; // Cloudflare Workers' WebCrypto maximum for PBKDF2
const SESSION_HOURS = 12;
export const COOKIE = 'nq_session';

// ---------- Passwords ----------
function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(bits)}`;
}
export async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) return false;
  const [, iter, salt, hash] = stored.split('$');
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: Number(iter) }, key, 256);
  return timingSafeEqual(b64(bits), hash);
}
export function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 12) throw new HttpError(400, 'WEAK_PASSWORD', 'Password must be at least 12 characters.');
  if (pw.length > 200) throw new HttpError(400, 'WEAK_PASSWORD', 'Password is too long.');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) throw new HttpError(400, 'WEAK_PASSWORD', 'Use at least three of: lowercase, uppercase, digits, symbols.');
}

// ---------- TOTP (RFC 6238) for administrator MFA ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function b32decode(s) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}
export async function totpAt(secret, counter) {
  const key = await crypto.subtle.importKey('raw', b32decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8);
  new DataView(msg).setUint32(4, counter);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[19] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
export async function verifyTotp(secret, code) {
  if (!secret || !/^\d{6}$/.test(String(code || ''))) return false;
  const c = Math.floor(Date.now() / 30000);
  for (const d of [-1, 0, 1]) if (timingSafeEqual(await totpAt(secret, c + d), String(code))) return true;
  return false;
}

// ---------- Rate limiting (fixed window in D1) ----------
export async function rateLimit(env, key, limit, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start < ?2 - ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start < ?2 - ?3 THEN ?2 ELSE window_start END
     RETURNING count`
  ).bind(key, now, windowSec).first();
  if (row && row.count > limit) throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.');
}

// ---------- Sessions ----------
export function getCookie(request, name) {
  const c = request.headers.get('cookie') || '';
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
export function sessionCookie(token, request, maxAge = SESSION_HOURS * 3600) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
export async function createSession(env, request, user, mfaOk) {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const now = new Date();
  const csrf = randomToken(24);
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, tenant_id, csrf, mfa_ok, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, user.id, user.tenant_id, csrf, mfaOk ? 1 : 0, now.toISOString(), now.toISOString(),
    new Date(now.getTime() + SESSION_HOURS * 3600e3).toISOString(),
    request.headers.get('cf-connecting-ip') || '', (request.headers.get('user-agent') || '').slice(0, 200)).run();
  return { token, csrf };
}

// Loads the session, user, roles, permissions and class scope for this request.
export async function loadContext(env, request) {
  const token = getCookie(request, COOKIE);
  if (!token) return null;
  const sid = await sha256Hex(token);
  const s = await env.DB.prepare(
    `SELECT s.*, u.email, u.display_name, u.status AS user_status, u.mfa_enabled, u.preferred_language
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`
  ).bind(sid, nowIso()).first();
  if (!s || s.user_status !== 'active') return null;
  const tenant = await env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(s.tenant_id).first();
  if (!tenant || tenant.status !== 'active') return null;
  // Permissions are read on every request, so a permission change applies to the very next call.
  const roleRows = (await env.DB.prepare(
    `SELECT r.id, r.code, r.name_en, r.name_ar, r.requires_mfa, ur.campus_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND ur.tenant_id = ?`
  ).bind(s.user_id, s.tenant_id).all()).results;
  const permRows = roleRows.length ? (await env.DB.prepare(
    `SELECT DISTINCT rp.permission FROM role_permissions rp JOIN user_roles ur ON ur.role_id = rp.role_id
      WHERE ur.user_id = ? AND ur.tenant_id = ?`
  ).bind(s.user_id, s.tenant_id).all()).results : [];
  const perms = new Set(permRows.map((r) => r.permission));
  const staff = await env.DB.prepare('SELECT id, staff_code FROM staff WHERE user_id = ? AND tenant_id = ?').bind(s.user_id, s.tenant_id).first();
  const guardian = await env.DB.prepare('SELECT id FROM guardians WHERE user_id = ? AND tenant_id = ?').bind(s.user_id, s.tenant_id).first();
  const mfaRequired = roleRows.some((r) => r.requires_mfa);
  // Touch session at most every 5 minutes.
  if (Date.now() - Date.parse(s.last_seen_at) > 300e3) {
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(nowIso(), sid).run();
  }
  return {
    sessionId: sid, csrf: s.csrf, mfaOk: !!s.mfa_ok,
    user: { id: s.user_id, email: s.email, display_name: s.display_name, mfa_enabled: !!s.mfa_enabled, preferred_language: s.preferred_language },
    tenant, tenantId: s.tenant_id, roles: roleRows, perms, staffId: staff ? staff.id : null,
    guardianId: guardian ? guardian.id : null, mfaRequired,
    needsMfaEnrollment: mfaRequired && !s.mfa_enabled,
  };
}

export function can(ctx, perm) { return !!ctx && ctx.perms.has(perm); }
export function require(ctx, ...perms) {
  if (!ctx) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.');
  for (const p of perms) if (!ctx.perms.has(p)) throw forbidden();
}

// Class scope: null = all classes; otherwise the array of class IDs the user teaches or leads.
export async function classScope(env, ctx) {
  if (ctx.perms.has('scope.all_classes')) return null;
  if (!ctx.staffId) return [];
  const rows = (await env.DB.prepare(
    `SELECT id FROM classes WHERE tenant_id = ?1 AND class_teacher_staff_id = ?2
     UNION SELECT class_id FROM teaching_assignments WHERE tenant_id = ?1 AND staff_id = ?2`
  ).bind(ctx.tenantId, ctx.staffId).all()).results;
  return rows.map((r) => r.id);
}
export async function assertClassInScope(env, ctx, classId) {
  const scope = await classScope(env, ctx);
  if (scope && !scope.includes(classId)) throw forbidden('This class is not assigned to you.');
}

// ---------- Audit (append-only, HMAC-signed rows) ----------
export async function audit(env, ctx, action, entity, entityId, details, reason) {
  const row = {
    id: newId('au_'), tenant_id: ctx?.tenantId || null, actor_user_id: ctx?.user?.id || null,
    action, entity: entity || null, entity_id: entityId || null, reason: reason || null,
    details: details ? JSON.stringify(details).slice(0, 4000) : null,
    ip: ctx?.ip || null, correlation_id: ctx?.correlationId || null, at: nowIso(),
  };
  const mac = await hmacHex(env.AUDIT_KEY || 'unset-audit-key', JSON.stringify(row));
  return env.DB.prepare(
    `INSERT INTO audit_log (id, tenant_id, actor_user_id, action, entity, entity_id, reason, details, ip, correlation_id, at, mac)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(row.id, row.tenant_id, row.actor_user_id, row.action, row.entity, row.entity_id, row.reason, row.details, row.ip, row.correlation_id, row.at, mac);
}
export async function verifyAuditRow(env, r) {
  const row = { id: r.id, tenant_id: r.tenant_id, actor_user_id: r.actor_user_id, action: r.action, entity: r.entity, entity_id: r.entity_id, reason: r.reason, details: r.details, ip: r.ip, correlation_id: r.correlation_id, at: r.at };
  return timingSafeEqual(await hmacHex(env.AUDIT_KEY || 'unset-audit-key', JSON.stringify(row)), r.mac);
}
