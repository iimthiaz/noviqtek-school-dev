import { HttpError, bad, code as codeField, emailField, json, newId, nowIso, readJson, sha256Hex, str, randomToken, timingSafeEqual } from '../lib/util.js';
import {
  audit, checkPasswordStrength, createSession, hashPassword, newTotpSecret, rateLimit, sessionCookie,
  verifyPassword, verifyTotp, COOKIE,
} from '../lib/auth.js';
import { ROLE_PRESETS } from '../lib/permissions.js';

async function takeToken(env, token, purpose) {
  if (!token || typeof token !== 'string' || token.length > 100) throw new HttpError(400, 'BAD_TOKEN', 'This link is invalid.');
  const h = await sha256Hex(token);
  const t = await env.DB.prepare('SELECT * FROM one_time_tokens WHERE token_hash = ? AND purpose = ?').bind(h, purpose).first();
  if (!t) throw new HttpError(400, 'BAD_TOKEN', 'This link is invalid.');
  if (t.used_at) throw new HttpError(400, 'TOKEN_USED', 'This link has already been used.');
  if (t.expires_at < nowIso()) throw new HttpError(400, 'TOKEN_EXPIRED', 'This link has expired. Ask for a new one.');
  return t;
}

// First-school bootstrap for one-click installs: the installer sets a SETUP_KEY secret in
// Cloudflare. It works only while no school exists; later schools need a one-time link.
async function setupKeyUsable(env) {
  if (!env.SETUP_KEY || String(env.SETUP_KEY).length < 12) return false;
  const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM tenants').first();
  return r.c === 0;
}
async function resolveSetup(env, b, { consume }) {
  if (b.token) return takeToken(env, b.token, 'school_setup');
  if (!b.setup_key) throw new HttpError(400, 'BAD_TOKEN', 'Enter the setup key chosen during installation.');
  if (!(await setupKeyUsable(env))) throw new HttpError(400, 'SETUP_KEY_UNAVAILABLE', 'Setup by key is only available before the first school exists.');
  if (!timingSafeEqual(await sha256Hex(String(b.setup_key)), await sha256Hex(String(env.SETUP_KEY)))) throw new HttpError(400, 'BAD_SETUP_KEY', 'The setup key is incorrect.');
  if (!consume) return { valid: true };
  const token = randomToken(32);
  const now = new Date();
  await env.DB.prepare("INSERT INTO one_time_tokens (token_hash, purpose, created_at, expires_at) VALUES (?, 'school_setup', ?, ?)")
    .bind(await sha256Hex(token), now.toISOString(), new Date(now.getTime() + 600e3).toISOString()).run();
  return takeToken(env, token, 'school_setup');
}

function meResponse(ctx) {
  return {
    user: ctx.user,
    csrf: ctx.csrf,
    needs_mfa_enrollment: ctx.needsMfaEnrollment,
    tenant: {
      id: ctx.tenant.id, code: ctx.tenant.code, name_en: ctx.tenant.name_en, name_ar: ctx.tenant.name_ar,
      logo_data: ctx.tenant.logo_data, primary_color: ctx.tenant.primary_color, accent_color: ctx.tenant.accent_color,
      timezone: ctx.tenant.timezone, currency: ctx.tenant.currency, working_days: ctx.tenant.working_days,
    },
    roles: ctx.roles.map((r) => ({ code: r.code, name_en: r.name_en, name_ar: r.name_ar })),
    permissions: [...ctx.perms].sort(),
    is_staff: !!ctx.staffId,
    is_guardian: !!ctx.guardianId,
  };
}

// Default sample structure: Year 1A–6B, timing groups Y1-2 and Y3-6. Dates are placeholders
// flagged for administrator confirmation — no calendar is hardcoded as official.
function defaultStructure(env, tenantId, campusId, now) {
  const y = new Date().getUTCFullYear();
  const startYear = new Date().getUTCMonth() >= 6 ? y : y - 1;
  const ay = { id: newId(), code: `AY${startYear}`, label: `${startYear}–${startYear + 1} (confirm dates)`, start_date: `${startYear}-08-20`, end_date: `${startYear + 1}-06-30` };
  const tg = [
    { id: newId(), code: 'Y1-2', name_en: 'Year 1–2 timings', name_ar: 'توقيت السنة ١–٢' },
    { id: newId(), code: 'Y3-6', name_en: 'Year 3–6 timings', name_ar: 'توقيت السنة ٣–٦' },
  ];
  const yg = [1, 2, 3, 4, 5, 6].map((n) => ({ id: newId(), code: `Y${n}`, name_en: `Year ${n}`, name_ar: `السنة ${n}`, sort_order: n, timing_group_id: n <= 2 ? tg[0].id : tg[1].id }));
  const classes = yg.flatMap((g) => ['A', 'B'].map((s) => ({ id: newId(), year_group_id: g.id, code: `${g.code}${s}`, name_en: `${g.name_en}${s}`, name_ar: `${g.name_ar} ${s === 'A' ? 'أ' : 'ب'}`, capacity: 24 })));
  return [
    env.DB.prepare('INSERT INTO academic_years (id, tenant_id, code, label, start_date, end_date, is_current, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)')
      .bind(ay.id, tenantId, ay.code, ay.label, ay.start_date, ay.end_date, now, now),
    env.DB.prepare(`INSERT INTO timing_groups (id, tenant_id, code, name_en, name_ar, created_at, updated_at)
      SELECT json_extract(value,'$.id'), ?1, json_extract(value,'$.code'), json_extract(value,'$.name_en'), json_extract(value,'$.name_ar'), ?2, ?2 FROM json_each(?3)`).bind(tenantId, now, JSON.stringify(tg)),
    env.DB.prepare(`INSERT INTO year_groups (id, tenant_id, code, name_en, name_ar, sort_order, timing_group_id, created_at, updated_at)
      SELECT json_extract(value,'$.id'), ?1, json_extract(value,'$.code'), json_extract(value,'$.name_en'), json_extract(value,'$.name_ar'), json_extract(value,'$.sort_order'), json_extract(value,'$.timing_group_id'), ?2, ?2 FROM json_each(?3)`).bind(tenantId, now, JSON.stringify(yg)),
    env.DB.prepare(`INSERT INTO classes (id, tenant_id, academic_year_id, campus_id, year_group_id, code, name_en, name_ar, capacity, created_at, updated_at)
      SELECT json_extract(value,'$.id'), ?1, ?2, ?3, json_extract(value,'$.year_group_id'), json_extract(value,'$.code'), json_extract(value,'$.name_en'), json_extract(value,'$.name_ar'), json_extract(value,'$.capacity'), ?4, ?4 FROM json_each(?5)`).bind(tenantId, ay.id, campusId, now, JSON.stringify(classes)),
  ];
}

export function seedRoles(env, tenantId, now) {
  const roles = ROLE_PRESETS.map(([code, name_en, name_ar, perms, mfa]) => ({ id: newId('r_'), code, name_en, name_ar, mfa, perms }));
  const rp = roles.flatMap((r) => r.perms.map((p) => ({ role_id: r.id, permission: p })));
  return {
    roles,
    stmts: [
      env.DB.prepare(`INSERT INTO roles (id, tenant_id, code, name_en, name_ar, is_preset, requires_mfa, created_at)
        SELECT json_extract(value,'$.id'), ?1, json_extract(value,'$.code'), json_extract(value,'$.name_en'), json_extract(value,'$.name_ar'), 1, json_extract(value,'$.mfa'), ?2 FROM json_each(?3)`)
        .bind(tenantId, now, JSON.stringify(roles.map(({ perms, ...r }) => r))),
      env.DB.prepare(`INSERT INTO role_permissions (role_id, permission) SELECT json_extract(value,'$.role_id'), json_extract(value,'$.permission') FROM json_each(?1)`)
        .bind(JSON.stringify(rp)),
    ],
  };
}

export default [
  ['GET', '/api/health', async ({ env }) => {
    const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM tenants').first();
    return json({ status: 'ok', database: 'ok', schools_configured: r.c > 0, setup_key_available: r.c === 0 && !!env.SETUP_KEY && String(env.SETUP_KEY).length >= 12, time: nowIso(), audit_key_configured: !!env.AUDIT_KEY });
  }, { public: true }],

  ['POST', '/api/setup/check', async ({ request, env }) => {
    const b = await readJson(request);
    await rateLimit(env, 'setup:' + (request.headers.get('cf-connecting-ip') || ''), 20, 3600);
    await resolveSetup(env, b, { consume: false });
    return json({ valid: true });
  }, { public: true }],

  ['POST', '/api/setup', async ({ request, env }) => {
    const b = await readJson(request);
    await rateLimit(env, 'setup:' + (request.headers.get('cf-connecting-ip') || ''), 20, 3600);
    const t = await resolveSetup(env, b, { consume: true });
    const schoolCode = codeField(b.school_code, { name: 'School code', max: 20 }).toUpperCase();
    const nameEn = str(b.name_en, { required: true, name: 'School name (English)' });
    const nameAr = str(b.name_ar, { name: 'School name (Arabic)' });
    const adminName = str(b.admin_name, { required: true, name: 'Administrator name' });
    const email = emailField(b.admin_email, { required: true, name: 'Administrator email' });
    checkPasswordStrength(b.password);
    if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) throw bad('This email is already registered.');
    if (await env.DB.prepare('SELECT 1 FROM tenants WHERE code = ?').bind(schoolCode).first()) throw bad('This school code is already in use.');

    const now = nowIso();
    const tenantId = newId('t_');
    const campusId = newId();
    const userId = newId('u_');
    const { roles, stmts: roleStmts } = seedRoles(env, tenantId, now);
    const superRole = roles.find((r) => r.code === 'school_super_admin');
    const pw = await hashPassword(b.password);
    const stmts = [
      env.DB.prepare('UPDATE one_time_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(now, t.token_hash),
      // Inserted only if *this* request consumed the token; otherwise every dependent insert fails its
      // foreign key and D1 rolls back the whole batch (prevents double use of one setup link).
      env.DB.prepare('INSERT INTO tenants (id, code, name_en, name_ar, created_at, updated_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM one_time_tokens WHERE token_hash = ? AND used_at = ?)')
        .bind(tenantId, schoolCode, nameEn, nameAr, now, now, t.token_hash, now),
      env.DB.prepare("INSERT INTO campuses (id, tenant_id, code, name_en, name_ar, created_at, updated_at) VALUES (?,?,'MAIN','Main Campus','الحرم الرئيسي',?,?)").bind(campusId, tenantId, now, now),
      ...roleStmts,
      env.DB.prepare("INSERT INTO users (id, tenant_id, email, display_name, password_hash, status, created_at, updated_at) VALUES (?,?,?,?,?,'active',?,?)").bind(userId, tenantId, email, adminName, pw, now, now),
      env.DB.prepare('INSERT INTO user_roles (id, tenant_id, user_id, role_id, created_at) VALUES (?,?,?,?,?)').bind(newId(), tenantId, userId, superRole.id, now),
      ...(b.create_default_structure !== false ? defaultStructure(env, tenantId, campusId, now) : []),
      await audit(env, { tenantId, user: { id: userId } }, 'school.setup', 'tenant', tenantId, { school_code: schoolCode, default_structure: b.create_default_structure !== false }),
    ];
    const results = await env.DB.batch(stmts);
    if (!results[0].meta.changes) throw new HttpError(409, 'TOKEN_USED', 'This setup link has already been used.');
    const { token } = await createSession(env, request, { id: userId, tenant_id: tenantId }, false);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, request) });
  }, { public: true }],

  ['POST', '/api/login', async ({ request, env }) => {
    const b = await readJson(request);
    const email = emailField(b.email, { required: true });
    const ip = request.headers.get('cf-connecting-ip') || '';
    await rateLimit(env, 'login-ip:' + ip, 30, 900);
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    const generic = new HttpError(401, 'LOGIN_FAILED', 'Email or password is incorrect.');
    if (!u || u.status !== 'active' || !u.password_hash) { await hashPassword('timing-equalizer'); throw generic; }
    if (u.locked_until && u.locked_until > nowIso()) throw new HttpError(423, 'LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
    if (!(await verifyPassword(String(b.password || ''), u.password_hash))) {
      const fails = u.failed_logins + 1;
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').bind(fails >= 5 ? 0 : fails, fails >= 5 ? new Date(Date.now() + 900e3).toISOString() : null, u.id),
        await audit(env, { tenantId: u.tenant_id, user: { id: u.id }, ip }, 'auth.login_failed', 'user', u.id),
      ]);
      throw generic;
    }
    if (u.mfa_enabled) {
      if (!b.mfa_code) return json({ mfa_required: true });
      if (!(await verifyTotp(u.mfa_secret, b.mfa_code))) throw new HttpError(401, 'MFA_FAILED', 'The authentication code is incorrect.');
    }
    const { token } = await createSession(env, request, u, !!u.mfa_enabled);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').bind(nowIso(), u.id),
      await audit(env, { tenantId: u.tenant_id, user: { id: u.id }, ip }, 'auth.login', 'user', u.id),
    ]);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, request) });
  }, { public: true }],

  ['POST', '/api/logout', async ({ request, env, ctx }) => {
    await env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').bind(nowIso(), ctx.sessionId).run();
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  }],

  ['GET', '/api/me', async ({ ctx }) => json(meResponse(ctx))],

  ['POST', '/api/mfa/setup', async ({ env, ctx }) => {
    if (ctx.user.mfa_enabled) throw bad('Two-factor authentication is already enabled.');
    const secret = newTotpSecret();
    await env.DB.prepare('UPDATE users SET mfa_secret = ? WHERE id = ? AND mfa_enabled = 0').bind(secret, ctx.user.id).run();
    const issuer = encodeURIComponent('Noviqtek School');
    return json({ secret, otpauth: `otpauth://totp/${issuer}:${encodeURIComponent(ctx.user.email)}?secret=${secret}&issuer=${issuer}&digits=6&period=30` });
  }],

  ['POST', '/api/mfa/enable', async ({ request, env, ctx }) => {
    const b = await readJson(request);
    const u = await env.DB.prepare('SELECT mfa_secret FROM users WHERE id = ?').bind(ctx.user.id).first();
    if (!(await verifyTotp(u.mfa_secret, b.code))) throw new HttpError(400, 'MFA_FAILED', 'The code did not match. Check the time on your phone and try again.');
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET mfa_enabled = 1, updated_at = ? WHERE id = ?').bind(nowIso(), ctx.user.id),
      env.DB.prepare('UPDATE sessions SET mfa_ok = 1 WHERE id = ?').bind(ctx.sessionId),
      await audit(env, ctx, 'auth.mfa_enabled', 'user', ctx.user.id),
    ]);
    return json({ ok: true });
  }],

  ['POST', '/api/invite/check', async ({ request, env }) => {
    const b = await readJson(request);
    await rateLimit(env, 'invite:' + (request.headers.get('cf-connecting-ip') || ''), 30, 3600);
    const t = await takeToken(env, b.token, b.purpose === 'password_reset' ? 'password_reset' : 'invite');
    const u = await env.DB.prepare('SELECT email, display_name FROM users WHERE id = ?').bind(t.user_id).first();
    return json({ email: u.email, display_name: u.display_name });
  }, { public: true }],

  ['POST', '/api/invite/accept', async ({ request, env }) => {
    const b = await readJson(request);
    await rateLimit(env, 'invite:' + (request.headers.get('cf-connecting-ip') || ''), 30, 3600);
    const purpose = b.purpose === 'password_reset' ? 'password_reset' : 'invite';
    const t = await takeToken(env, b.token, purpose);
    checkPasswordStrength(b.password);
    const pw = await hashPassword(b.password);
    const now = nowIso();
    const res = await env.DB.batch([
      env.DB.prepare('UPDATE one_time_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(now, t.token_hash),
      env.DB.prepare("UPDATE users SET password_hash = ?, status = 'active', failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?").bind(pw, now, t.user_id),
      env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, t.user_id),
      await audit(env, { tenantId: t.tenant_id, user: { id: t.user_id } }, purpose === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset', 'user', t.user_id),
    ]);
    if (!res[0].meta.changes) throw new HttpError(409, 'TOKEN_USED', 'This link has already been used.');
    return json({ ok: true });
  }, { public: true }],

  ['POST', '/api/password/change', async ({ request, env, ctx }) => {
    const b = await readJson(request);
    const u = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(ctx.user.id).first();
    if (!(await verifyPassword(String(b.current_password || ''), u.password_hash))) throw new HttpError(400, 'LOGIN_FAILED', 'Current password is incorrect.');
    checkPasswordStrength(b.new_password);
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(await hashPassword(b.new_password), now, ctx.user.id),
      env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL').bind(now, ctx.user.id, ctx.sessionId),
      await audit(env, ctx, 'auth.password_changed', 'user', ctx.user.id),
    ]);
    return json({ ok: true });
  }],
];

export { takeToken, randomToken };
