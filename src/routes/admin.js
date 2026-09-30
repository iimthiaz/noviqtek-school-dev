import { HttpError, bad, code as codeField, conflict, emailField, forbidden, json, newId, notFound, nowIso, paging, readJson, sha256Hex, str, randomToken } from '../lib/util.js';
import { audit, require, verifyAuditRow } from '../lib/auth.js';
import { PERMISSIONS } from '../lib/permissions.js';

const INVITE_DAYS = 7;

async function issueUserToken(env, tenantId, userId, purpose) {
  const token = randomToken(32);
  const now = new Date();
  return {
    token,
    stmt: env.DB.prepare('INSERT INTO one_time_tokens (token_hash, purpose, tenant_id, user_id, created_at, expires_at) VALUES (?,?,?,?,?,?)')
      .bind(await sha256Hex(token), purpose, tenantId, userId, now.toISOString(), new Date(now.getTime() + (purpose === 'invite' ? INVITE_DAYS * 86400e3 : 86400e3)).toISOString()),
  };
}

async function tenantRoles(env, tenantId, ids) {
  if (!Array.isArray(ids) || !ids.length) throw bad('Select at least one role.');
  const rows = (await env.DB.prepare('SELECT r.id, r.code FROM roles r JOIN json_each(?2) j ON r.id = j.value WHERE r.tenant_id = ?1').bind(tenantId, JSON.stringify(ids)).all()).results;
  if (rows.length !== new Set(ids).size) throw bad('One or more roles do not belong to this school.');
  return rows;
}
// A user may only hand out roles whose permissions they already hold (prevents privilege escalation).
async function assertCanGrant(env, ctx, roleIds) {
  const perms = (await env.DB.prepare('SELECT DISTINCT permission FROM role_permissions rp JOIN json_each(?1) j ON rp.role_id = j.value').bind(JSON.stringify(roleIds)).all()).results;
  const missing = perms.map((p) => p.permission).filter((p) => !ctx.perms.has(p));
  if (missing.length) throw forbidden(`You cannot grant permissions you do not hold: ${missing.slice(0, 5).join(', ')}`);
}

export default [
  // ---------- School settings & branding ----------
  ['GET', '/api/settings', async ({ ctx }) => {
    require(ctx, 'tenant.configure');
    return json({ tenant: ctx.tenant });
  }],
  ['PUT', '/api/settings', async ({ request, env, ctx }) => {
    require(ctx, 'tenant.configure');
    const b = await readJson(request, 400_000);
    const color = (v, n) => { const s = str(v, { name: n, max: 7 }); if (s && !/^#[0-9a-fA-F]{6}$/.test(s)) throw bad(`${n} must be a hex colour like #1d4e89.`); return s; };
    let logo = ctx.tenant.logo_data;
    if (b.logo_data !== undefined) {
      if (b.logo_data === null || b.logo_data === '') logo = null;
      else {
        if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.logo_data)) throw bad('Logo must be a PNG, JPEG or WebP image.');
        if (b.logo_data.length > 300_000) throw bad('Logo must be under about 200 KB.');
        logo = b.logo_data;
      }
    }
    const days = str(b.working_days, { name: 'Working days', max: 20 }) || ctx.tenant.working_days;
    if (!/^[0-6](,[0-6]){0,6}$/.test(days)) throw bad('Working days must be a list of weekday numbers 0–6 (0 = Sunday).');
    const v = {
      name_en: str(b.name_en, { required: true, name: 'School name (English)' }),
      name_ar: str(b.name_ar, { name: 'School name (Arabic)' }),
      primary_color: color(b.primary_color, 'Primary colour') || ctx.tenant.primary_color,
      accent_color: color(b.accent_color, 'Accent colour') || ctx.tenant.accent_color,
      address: str(b.address, { max: 400 }), phone: str(b.phone, { max: 30 }), email: emailField(b.email),
      working_days: days,
    };
    const res = await env.DB.batch([
      env.DB.prepare(`UPDATE tenants SET name_en=?, name_ar=?, primary_color=?, accent_color=?, address=?, phone=?, email=?, working_days=?, logo_data=?, updated_at=?, version=version+1
        WHERE id=? AND version=?`).bind(v.name_en, v.name_ar, v.primary_color, v.accent_color, v.address, v.phone, v.email, v.working_days, logo, nowIso(), ctx.tenantId, Number(b.version)),
      await audit(env, ctx, 'settings.update', 'tenant', ctx.tenantId, { ...v, logo_changed: logo !== ctx.tenant.logo_data }),
    ]);
    if (!res[0].meta.changes) throw conflict('Settings were changed by someone else. Reload and re-apply your changes.');
    return json({ ok: true });
  }],

  // ---------- Roles & permissions ----------
  ['GET', '/api/permissions', async ({ ctx }) => { require(ctx, 'role.manage'); return json({ permissions: PERMISSIONS }); }],
  ['GET', '/api/roles', async ({ env, ctx }) => {
    if (!ctx.perms.has('role.manage') && !ctx.perms.has('user.manage')) throw forbidden();
    const roles = (await env.DB.prepare('SELECT r.*, (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count FROM roles r WHERE tenant_id = ? ORDER BY is_preset DESC, name_en').bind(ctx.tenantId).all()).results;
    const rp = (await env.DB.prepare('SELECT rp.role_id, rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.tenant_id = ?').bind(ctx.tenantId).all()).results;
    for (const r of roles) r.permissions = rp.filter((x) => x.role_id === r.id).map((x) => x.permission);
    return json({ roles });
  }],
  ['POST', '/api/roles', async ({ request, env, ctx }) => {
    require(ctx, 'role.manage');
    const b = await readJson(request);
    const perms = [...new Set(b.permissions || [])];
    if (perms.some((p) => !PERMISSIONS[p])) throw bad('Unknown permission.');
    const missing = perms.filter((p) => !ctx.perms.has(p));
    if (missing.length) throw forbidden(`You cannot grant permissions you do not hold: ${missing.join(', ')}`);
    const id = newId('r_');
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO roles (id, tenant_id, code, name_en, name_ar, is_preset, requires_mfa, created_at) VALUES (?,?,?,?,?,0,?,?)')
        .bind(id, ctx.tenantId, codeField(b.code, { name: 'Role code' }).toLowerCase(), str(b.name_en, { required: true, name: 'Role name' }), str(b.name_ar), b.requires_mfa ? 1 : 0, now),
      env.DB.prepare('INSERT INTO role_permissions (role_id, permission) SELECT ?1, value FROM json_each(?2)').bind(id, JSON.stringify(perms)),
      await audit(env, ctx, 'role.create', 'role', id, { permissions: perms }),
    ]);
    return json({ id }, 201);
  }],
  ['PUT', '/api/roles/:id/permissions', async ({ request, env, ctx, params }) => {
    require(ctx, 'role.manage');
    const b = await readJson(request);
    const role = await env.DB.prepare('SELECT * FROM roles WHERE id = ? AND tenant_id = ?').bind(params.id, ctx.tenantId).first();
    if (!role) throw notFound();
    if (role.code === 'school_super_admin') throw bad('The school super administrator preset cannot be reduced.');
    const perms = [...new Set(b.permissions || [])];
    if (perms.some((p) => !PERMISSIONS[p])) throw bad('Unknown permission.');
    const before = (await env.DB.prepare('SELECT permission FROM role_permissions WHERE role_id = ?').bind(role.id).all()).results.map((r) => r.permission);
    const changed = [...perms.filter((p) => !before.includes(p)), ...before.filter((p) => !perms.includes(p))];
    const missing = changed.filter((p) => !ctx.perms.has(p));
    if (missing.length) throw forbidden(`You cannot change permissions you do not hold: ${missing.join(', ')}`);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM role_permissions WHERE role_id = ?').bind(role.id),
      env.DB.prepare('INSERT INTO role_permissions (role_id, permission) SELECT ?1, value FROM json_each(?2)').bind(role.id, JSON.stringify(perms)),
      env.DB.prepare('UPDATE roles SET requires_mfa = ? WHERE id = ?').bind(b.requires_mfa === undefined ? role.requires_mfa : (b.requires_mfa ? 1 : 0), role.id),
      await audit(env, ctx, 'role.permissions_update', 'role', role.id, { before, after: perms }),
    ]);
    return json({ ok: true });
  }],

  // ---------- Users ----------
  ['GET', '/api/users', async ({ env, ctx, url }) => {
    require(ctx, 'user.manage');
    const { size, offset } = paging(url);
    const q = `%${(url.searchParams.get('q') || '').trim()}%`;
    const rows = (await env.DB.prepare(
      `SELECT u.id, u.email, u.display_name, u.status, u.mfa_enabled, u.last_login_at, u.created_at,
        (SELECT group_concat(r.name_en, ', ') FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles,
        (SELECT json_group_array(ur.role_id) FROM user_roles ur WHERE ur.user_id = u.id) AS role_ids,
        (SELECT staff_code FROM staff s WHERE s.user_id = u.id) AS staff_code,
        (SELECT guardian_code FROM guardians g WHERE g.user_id = u.id) AS guardian_code
       FROM users u WHERE u.tenant_id = ?1 AND (u.email LIKE ?2 OR u.display_name LIKE ?2)
       ORDER BY u.display_name LIMIT ?3 OFFSET ?4`
    ).bind(ctx.tenantId, q, size, offset).all()).results;
    const total = await env.DB.prepare('SELECT COUNT(*) c FROM users WHERE tenant_id = ?1 AND (email LIKE ?2 OR display_name LIKE ?2)').bind(ctx.tenantId, q).first();
    for (const r of rows) r.role_ids = JSON.parse(r.role_ids || '[]');
    return json({ rows, total: total.c });
  }],
  ['POST', '/api/users/invite', async ({ request, env, ctx }) => {
    require(ctx, 'user.manage');
    const b = await readJson(request);
    const email = emailField(b.email, { required: true });
    const name = str(b.display_name, { required: true, name: 'Name' });
    const roles = await tenantRoles(env, ctx.tenantId, b.role_ids);
    await assertCanGrant(env, ctx, roles.map((r) => r.id));
    if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) throw conflict('A user with this email already exists.');
    const userId = newId('u_');
    const now = nowIso();
    const stmts = [
      env.DB.prepare("INSERT INTO users (id, tenant_id, email, display_name, status, created_at, updated_at) VALUES (?,?,?,?,'invited',?,?)").bind(userId, ctx.tenantId, email, name, now, now),
      ...roles.map((r) => env.DB.prepare('INSERT INTO user_roles (id, tenant_id, user_id, role_id, created_at) VALUES (?,?,?,?,?)').bind(newId(), ctx.tenantId, userId, r.id, now)),
    ];
    // Optional explicit link to an existing staff or guardian record (never inferred from email).
    if (b.staff_id) {
      const s = await env.DB.prepare('SELECT id, user_id FROM staff WHERE id = ? AND tenant_id = ?').bind(b.staff_id, ctx.tenantId).first();
      if (!s) throw bad('Staff record not found.');
      if (s.user_id) throw conflict('This staff record is already linked to a user.');
      stmts.push(env.DB.prepare('UPDATE staff SET user_id = ?, updated_at = ? WHERE id = ?').bind(userId, now, s.id));
    }
    if (b.guardian_id) {
      const g = await env.DB.prepare('SELECT id, user_id FROM guardians WHERE id = ? AND tenant_id = ?').bind(b.guardian_id, ctx.tenantId).first();
      if (!g) throw bad('Guardian record not found.');
      if (g.user_id) throw conflict('This guardian is already linked to a user.');
      stmts.push(env.DB.prepare('UPDATE guardians SET user_id = ?, updated_at = ? WHERE id = ?').bind(userId, now, g.id));
    }
    const { token, stmt } = await issueUserToken(env, ctx.tenantId, userId, 'invite');
    stmts.push(stmt, await audit(env, ctx, 'user.invite', 'user', userId, { email, roles: roles.map((r) => r.code), staff_id: b.staff_id || null, guardian_id: b.guardian_id || null }));
    await env.DB.batch(stmts);
    return json({ id: userId, invite_path: `/#/invite/${token}`, expires_days: INVITE_DAYS }, 201);
  }],
  ['PUT', '/api/users/:id/roles', async ({ request, env, ctx, params }) => {
    require(ctx, 'user.manage');
    const b = await readJson(request);
    const u = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ?').bind(params.id, ctx.tenantId).first();
    if (!u) throw notFound();
    const roles = await tenantRoles(env, ctx.tenantId, b.role_ids);
    const current = (await env.DB.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').bind(u.id).all()).results.map((r) => r.role_id);
    const changed = [...roles.map((r) => r.id).filter((id) => !current.includes(id)), ...current.filter((id) => !roles.some((r) => r.id === id))];
    if (changed.length) await assertCanGrant(env, ctx, changed);
    if (u.id === ctx.user.id && !roles.some((r) => r.code === 'school_super_admin') && ctx.roles.some((r) => r.code === 'school_super_admin')) {
      const others = await env.DB.prepare("SELECT COUNT(*) c FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users x ON x.id = ur.user_id WHERE r.tenant_id = ? AND r.code = 'school_super_admin' AND x.status = 'active' AND ur.user_id != ?").bind(ctx.tenantId, u.id).first();
      if (!others.c) throw bad('You are the only active super administrator; assign another before removing your own role.');
    }
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(u.id),
      ...roles.map((r) => env.DB.prepare('INSERT INTO user_roles (id, tenant_id, user_id, role_id, created_at) VALUES (?,?,?,?,?)').bind(newId(), ctx.tenantId, u.id, r.id, now)),
      env.DB.prepare('UPDATE users SET permissions_version = permissions_version + 1, updated_at = ? WHERE id = ?').bind(now, u.id),
      await audit(env, ctx, 'user.roles_update', 'user', u.id, { before: current, after: roles.map((r) => r.code) }),
    ]);
    return json({ ok: true });
  }],
  ['POST', '/api/users/:id/status', async ({ request, env, ctx, params }) => {
    require(ctx, 'user.manage');
    const b = await readJson(request);
    if (!['active', 'disabled'].includes(b.status)) throw bad('status must be active or disabled.');
    if (params.id === ctx.user.id) throw bad('You cannot change your own status.');
    const u = await env.DB.prepare('SELECT id, password_hash FROM users WHERE id = ? AND tenant_id = ?').bind(params.id, ctx.tenantId).first();
    if (!u) throw notFound();
    const status = b.status === 'active' && !u.password_hash ? 'invited' : b.status;
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').bind(status, now, u.id),
      env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, u.id),
      await audit(env, ctx, 'user.status', 'user', u.id, { status }, str(b.reason, { max: 300 })),
    ]);
    return json({ ok: true });
  }],
  ['POST', '/api/users/:id/reset-link', async ({ env, ctx, params }) => {
    require(ctx, 'user.manage');
    const u = await env.DB.prepare('SELECT id, status FROM users WHERE id = ? AND tenant_id = ?').bind(params.id, ctx.tenantId).first();
    if (!u) throw notFound();
    const purpose = u.status === 'invited' ? 'invite' : 'password_reset';
    const { token, stmt } = await issueUserToken(env, ctx.tenantId, u.id, purpose);
    await env.DB.batch([stmt, await audit(env, ctx, 'user.reset_link', 'user', u.id, { purpose })]);
    return json({ path: purpose === 'invite' ? `/#/invite/${token}` : `/#/reset/${token}` });
  }],
  ['POST', '/api/users/:id/reset-mfa', async ({ request, env, ctx, params }) => {
    require(ctx, 'user.manage');
    const b = await readJson(request);
    const reason = str(b.reason, { required: true, name: 'Reason', max: 300 });
    const u = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ?').bind(params.id, ctx.tenantId).first();
    if (!u) throw notFound();
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, updated_at = ? WHERE id = ?').bind(now, u.id),
      env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, u.id),
      await audit(env, ctx, 'user.mfa_reset', 'user', u.id, null, reason),
    ]);
    return json({ ok: true });
  }],

  // ---------- Audit log ----------
  ['GET', '/api/audit', async ({ env, ctx, url }) => {
    require(ctx, 'audit.view');
    const { size, offset } = paging(url);
    const action = url.searchParams.get('action') || '';
    const rows = (await env.DB.prepare(
      `SELECT a.*, u.display_name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.tenant_id = ?1 AND (?2 = '' OR a.action LIKE ?2 || '%') ORDER BY a.at DESC LIMIT ?3 OFFSET ?4`
    ).bind(ctx.tenantId, action, size, offset).all()).results;
    for (const r of rows) r.verified = await verifyAuditRow(env, r);
    const total = await env.DB.prepare("SELECT COUNT(*) c FROM audit_log WHERE tenant_id = ?1 AND (?2 = '' OR action LIKE ?2 || '%')").bind(ctx.tenantId, action).first();
    return json({ rows, total: total.c });
  }],
];
