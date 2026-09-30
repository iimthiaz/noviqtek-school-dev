// Smart dismissal: reception/gate calls, family QR check-in, teacher confirmation.
// Operational statuses are only "called" and "dismissed"; no record = neutral "not called".
import { HttpError, bad, conflict, json, newId, notFound, nowIso, readJson, str, sha256Hex, randomToken, localDate, dateField } from '../lib/util.js';
import { audit, assertClassInScope, classScope, require } from '../lib/auth.js';

const SESSION = 'PM';
const CHANNELS = ['reception', 'gate', 'qr', 'bus', 'early'];

async function nextSequence(env, tenantId, name, n = 1) {
  const r = await env.DB.prepare(
    'INSERT INTO sequences (tenant_id, name, value) VALUES (?1, ?2, ?3) ON CONFLICT (tenant_id, name) DO UPDATE SET value = value + ?3 RETURNING value'
  ).bind(tenantId, name, n).first();
  return r.value - n + 1; // first number of the reserved range
}

async function eligibility(env, ctx, studentIds, date) {
  const rows = (await env.DB.prepare(
    `SELECT s.id, s.admission_no, s.official_name_en, s.official_name_ar, s.preferred_name, s.status,
       (SELECT e.class_id FROM enrollments e WHERE e.student_id = s.id AND e.enrollment_status = 'active' AND e.start_date <= ?2 AND (e.end_date IS NULL OR e.end_date >= ?2) LIMIT 1) AS class_id,
       (SELECT a.status_code FROM attendance a WHERE a.student_id = s.id AND a.attendance_date = ?2 AND a.session_code = 'DAY') AS attendance,
       (SELECT d.status FROM dismissal_records d WHERE d.student_id = s.id AND d.dismissal_date = ?2 AND d.session_code = ?3 AND d.tenant_id = s.tenant_id) AS dismissal
     FROM students s WHERE s.tenant_id = ?1 AND s.id IN (SELECT value FROM json_each(?4))`
  ).bind(ctx.tenantId, date, SESSION, JSON.stringify(studentIds)).all()).results;
  for (const r of rows) {
    r.reason = r.status !== 'active' ? 'inactive' : !r.class_id ? 'not_enrolled' : r.attendance === 'absent' ? 'absent'
      : r.dismissal === 'dismissed' ? 'already_dismissed' : r.dismissal === 'called' ? 'already_called' : null;
    r.eligible = !r.reason;
  }
  return rows;
}

async function performCall(env, ctx, { studentIds, channel, credentialId, idemKey, date }) {
  if (idemKey) {
    const prev = await env.DB.prepare('SELECT response FROM idempotency_keys WHERE tenant_id = ? AND key = ?').bind(ctx.tenantId, idemKey).first();
    if (prev) return { ...JSON.parse(prev.response), replayed: true };
  }
  const rows = await eligibility(env, ctx, studentIds, date);
  const toCall = rows.filter((r) => r.eligible).map((r) => ({ id: newId('d_'), student_id: r.id, class_id: r.class_id }));
  const now = nowIso();
  const stmts = [];
  if (toCall.length) {
    // Unique (date, session, student) + ON CONFLICT DO NOTHING makes simultaneous scans/calls safe.
    stmts.push(env.DB.prepare(`INSERT INTO dismissal_records (id, tenant_id, dismissal_date, session_code, student_id, class_id, status, called_at, called_by, channel, family_credential_id, updated_at)
      SELECT json_extract(value,'$.id'), ?1, ?2, ?3, json_extract(value,'$.student_id'), json_extract(value,'$.class_id'), 'called', ?4, ?5, ?6, ?7, ?4 FROM json_each(?8) WHERE true
      ON CONFLICT (tenant_id, dismissal_date, session_code, student_id) DO NOTHING`)
      .bind(ctx.tenantId, date, SESSION, now, ctx.user.id, channel, credentialId || null, JSON.stringify(toCall)));
    stmts.push(env.DB.prepare(`INSERT INTO dismissal_events (id, tenant_id, record_id, event_type, actor_user_id, channel, at)
      SELECT lower(hex(randomblob(12))), tenant_id, id, 'called', ?2, ?3, ?4 FROM dismissal_records WHERE id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(toCall.map((x) => x.id)), ctx.user.id, channel, now));
    stmts.push(await audit(env, ctx, 'dismissal.call', 'dismissal', null, { channel, students: toCall.length, credential: credentialId || null }));
  }
  let inserted = 0;
  if (stmts.length) inserted = (await env.DB.batch(stmts))[0].meta.changes;
  const result = {
    called: rows.filter((r) => r.eligible).map((r) => ({ student_id: r.id, name: r.official_name_en, name_ar: r.official_name_ar })),
    excluded: rows.filter((r) => !r.eligible).map((r) => ({ student_id: r.id, name: r.official_name_en, name_ar: r.official_name_ar, reason: r.reason })),
    newly_called: inserted,
  };
  if (idemKey) await env.DB.prepare('INSERT OR IGNORE INTO idempotency_keys (tenant_id, key, response, created_at) VALUES (?,?,?,?)').bind(ctx.tenantId, idemKey, JSON.stringify(result), now).run();
  return result;
}

async function resolveCredential(env, ctx, token) {
  if (typeof token !== 'string' || !/^NQF1[A-Za-z0-9_-]{20,64}$/.test(token.trim())) throw new HttpError(400, 'QR_INVALID', 'This is not a valid family check-in code.');
  const c = await env.DB.prepare(
    `SELECT fc.*, f.family_code, f.family_label FROM family_credentials fc JOIN families f ON f.id = fc.family_id
      WHERE fc.token_hash = ? AND fc.tenant_id = ?`
  ).bind(await sha256Hex(token.trim()), ctx.tenantId).first();
  if (!c) throw new HttpError(404, 'QR_UNKNOWN', 'This family code is not recognised at this school.');
  if (c.status !== 'active') {
    await (await audit(env, ctx, 'dismissal.qr_revoked_attempt', 'family_credential', c.id)).run();
    throw new HttpError(410, 'QR_REVOKED', 'This family card has been revoked. Use manual verification and contact the office.');
  }
  return c;
}

// Children eligible through a family: explicitly linked, link currently valid, and at least
// one pickup-authorised guardian in that family.
async function familyChildren(env, ctx, familyId, date) {
  return (await env.DB.prepare(
    `SELECT sg.student_id, MAX(sg.pickup_authorized) AS pickup_ok FROM student_guardians sg
      WHERE sg.family_id = ?1 AND sg.tenant_id = ?2 AND (sg.valid_from IS NULL OR sg.valid_from <= ?3) AND (sg.valid_to IS NULL OR sg.valid_to >= ?3)
      GROUP BY sg.student_id`
  ).bind(familyId, ctx.tenantId, date).all()).results;
}

export default [
  ['POST', '/api/dismissal/call', async ({ request, env, ctx }) => {
    require(ctx, 'dismissal.call');
    const b = await readJson(request);
    const channel = CHANNELS.includes(b.channel) && b.channel !== 'qr' ? b.channel : 'reception';
    if (!Array.isArray(b.student_ids) || !b.student_ids.length || b.student_ids.length > 50) throw bad('Select between 1 and 50 students.');
    const date = localDate(ctx.tenant.timezone);
    return json(await performCall(env, ctx, { studentIds: b.student_ids.map(String), channel, idemKey: str(b.idempotency_key, { max: 80 }), date }));
  }],

  ['POST', '/api/dismissal/family-lookup', async ({ request, env, ctx }) => {
    require(ctx, 'dismissal.call');
    const b = await readJson(request);
    const c = await resolveCredential(env, ctx, b.token);
    const date = localDate(ctx.tenant.timezone);
    const kids = await familyChildren(env, ctx, c.family_id, date);
    const elig = kids.length ? await eligibility(env, ctx, kids.map((k) => k.student_id), date) : [];
    for (const e of elig) if (e.eligible && !kids.find((k) => k.student_id === e.id).pickup_ok) { e.eligible = false; e.reason = 'no_authorized_collector'; }
    const classCodes = elig.length ? (await env.DB.prepare('SELECT id, code FROM classes WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(elig.map((e) => e.class_id).filter(Boolean))).all()).results : [];
    const collectors = (await env.DB.prepare(
      `SELECT DISTINCT g.official_name_en, g.official_name_ar, sg.relationship_code FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
        WHERE sg.family_id = ? AND sg.tenant_id = ? AND sg.pickup_authorized = 1 AND (sg.valid_to IS NULL OR sg.valid_to >= ?)`
    ).bind(c.family_id, ctx.tenantId, date).all()).results;
    return json({
      family: { code: c.family_code, label: c.family_label, card_reference: c.reference },
      authorized_collectors: collectors,
      children: elig.map((e) => ({ student_id: e.id, name: e.official_name_en, name_ar: e.official_name_ar, class_code: classCodes.find((x) => x.id === e.class_id)?.code || null, eligible: e.eligible, reason: e.reason, dismissal: e.dismissal })),
      notice: 'A QR card is a check-in credential only. Verify the collector against the authorised list before release.',
    });
  }],

  ['POST', '/api/dismissal/checkin', async ({ request, env, ctx }) => {
    require(ctx, 'dismissal.call');
    const b = await readJson(request);
    const c = await resolveCredential(env, ctx, b.token);
    const date = localDate(ctx.tenant.timezone);
    const kids = await familyChildren(env, ctx, c.family_id, date);
    let ids = kids.filter((k) => k.pickup_ok).map((k) => k.student_id);
    if (Array.isArray(b.student_ids) && b.student_ids.length) ids = ids.filter((id) => b.student_ids.includes(id));
    if (!ids.length) throw bad('No children in this family are authorised for pickup.');
    const res = await performCall(env, ctx, { studentIds: ids, channel: 'qr', credentialId: c.id, idemKey: str(b.idempotency_key, { max: 80 }), date });
    return json({ ...res, family: { code: c.family_code, card_reference: c.reference } });
  }],

  ['GET', '/api/dismissal/board', async ({ env, ctx, url }) => {
    require(ctx, 'dismissal.view');
    const date = localDate(ctx.tenant.timezone);
    const classId = url.searchParams.get('class_id') || '';
    const onlyActive = url.searchParams.get('view') !== 'all';
    if (classId) await assertClassInScope(env, ctx, classId);
    const scope = await classScope(env, ctx);
    // Teachers (scoped) always see their full class lists incl. "not called"; school-wide views default to called/dismissed.
    const includeNotCalled = !!scope || !!classId || !onlyActive;
    const rows = (await env.DB.prepare(
      `SELECT s.id AS student_id, s.official_name_en, s.official_name_ar, s.preferred_name, c.id AS class_id, c.code AS class_code,
         d.id AS record_id, d.status, d.called_at, d.channel, d.dismissed_at, d.version,
         (SELECT a.status_code FROM attendance a WHERE a.student_id = s.id AND a.attendance_date = ?2 AND a.session_code = 'DAY') AS attendance
       FROM enrollments e JOIN students s ON s.id = e.student_id JOIN classes c ON c.id = e.class_id
       LEFT JOIN dismissal_records d ON d.student_id = s.id AND d.dismissal_date = ?2 AND d.session_code = ?3 AND d.tenant_id = e.tenant_id
       WHERE e.tenant_id = ?1 AND e.enrollment_status = 'active' AND e.start_date <= ?2 AND (e.end_date IS NULL OR e.end_date >= ?2) AND s.status = 'active'
         AND (?4 = '' OR c.id = ?4) ${includeNotCalled ? '' : 'AND d.id IS NOT NULL'}
         ${scope ? 'AND c.id IN (SELECT value FROM json_each(?5))' : ''}
       ORDER BY CASE d.status WHEN 'called' THEN 0 WHEN 'dismissed' THEN 2 ELSE 1 END, d.called_at, c.code, s.official_name_en LIMIT 2000`
    ).bind(ctx.tenantId, date, SESSION, classId, ...(scope ? [JSON.stringify(scope)] : [])).all()).results;
    const counts = await env.DB.prepare(
      `SELECT SUM(status = 'called') AS called, SUM(status = 'dismissed') AS dismissed FROM dismissal_records d
        WHERE tenant_id = ?1 AND dismissal_date = ?2 AND session_code = ?3 ${scope ? 'AND class_id IN (SELECT value FROM json_each(?4))' : ''}`
    ).bind(ctx.tenantId, date, SESSION, ...(scope ? [JSON.stringify(scope)] : [])).first();
    return json({ date, session: SESSION, rows, counts: { called: counts.called || 0, dismissed: counts.dismissed || 0 }, server_time: nowIso(), scoped: !!scope });
  }],

  ['POST', '/api/dismissal/:id/dismiss', async ({ env, ctx, params }) => {
    require(ctx, 'dismissal.confirm');
    const rec = await env.DB.prepare('SELECT * FROM dismissal_records WHERE id = ? AND tenant_id = ?').bind(params.id, ctx.tenantId).first();
    if (!rec) throw notFound();
    await assertClassInScope(env, ctx, rec.class_id);
    if (rec.status === 'dismissed') return json({ ok: true, already: true });
    const now = nowIso();
    const res = await env.DB.batch([
      env.DB.prepare("UPDATE dismissal_records SET status = 'dismissed', dismissed_at = ?, dismissed_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND tenant_id = ? AND status = 'called'")
        .bind(now, ctx.user.id, now, rec.id, ctx.tenantId),
      env.DB.prepare("INSERT INTO dismissal_events (id, tenant_id, record_id, event_type, actor_user_id, at) SELECT ?, ?, ?, 'dismissed', ?, ? WHERE changes() > 0")
        .bind(newId(), ctx.tenantId, rec.id, ctx.user.id, now),
    ]);
    if (!res[0].meta.changes) return json({ ok: true, already: true });
    return json({ ok: true, dismissed_at: now });
  }],

  ['POST', '/api/dismissal/:id/reopen', async ({ request, env, ctx, params }) => {
    require(ctx, 'dismissal.reopen');
    const b = await readJson(request);
    const reason = str(b.reason, { required: true, name: 'Reason', max: 300 });
    const rec = await env.DB.prepare('SELECT * FROM dismissal_records WHERE id = ? AND tenant_id = ?').bind(params.id, ctx.tenantId).first();
    if (!rec) throw notFound();
    const now = nowIso();
    // Record is removed from the live queue (back to "not called"); full history stays in events + audit.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO dismissal_events (id, tenant_id, record_id, event_type, actor_user_id, reason, at) VALUES (?,?,?,'reopened',?,?,?)").bind(newId(), ctx.tenantId, rec.id, ctx.user.id, reason, now),
      env.DB.prepare('DELETE FROM dismissal_records WHERE id = ? AND tenant_id = ?').bind(rec.id, ctx.tenantId),
      await audit(env, ctx, 'dismissal.reopen', 'dismissal', rec.id, { student_id: rec.student_id, previous_status: rec.status, called_at: rec.called_at, dismissed_at: rec.dismissed_at }, reason),
    ]);
    return json({ ok: true });
  }],

  // ---------- Family QR credentials ----------
  ['GET', '/api/families/:id/credentials', async ({ env, ctx, params }) => {
    require(ctx, 'family.credentials');
    const rows = (await env.DB.prepare('SELECT id, reference, status, created_at, revoked_at, revoked_reason FROM family_credentials WHERE family_id = ? AND tenant_id = ? ORDER BY created_at DESC').bind(params.id, ctx.tenantId).all()).results;
    return json({ rows });
  }],
  // Issuing (or re-printing) replaces any active card for the family; only the hash is stored,
  // so the plain code is returned exactly once for printing.
  ['POST', '/api/families/credentials/issue', async ({ request, env, ctx }) => {
    require(ctx, 'family.credentials');
    const b = await readJson(request);
    if (!Array.isArray(b.family_ids) || !b.family_ids.length || b.family_ids.length > 300) throw bad('Select between 1 and 300 families.');
    const fams = (await env.DB.prepare("SELECT id, family_code, family_label FROM families WHERE tenant_id = ? AND status = 'active' AND id IN (SELECT value FROM json_each(?))").bind(ctx.tenantId, JSON.stringify(b.family_ids)).all()).results;
    if (fams.length !== new Set(b.family_ids).size) throw bad('One or more families were not found in this school.');
    const first = await nextSequence(env, ctx.tenantId, 'family_card', fams.length);
    const now = nowIso();
    const cards = [];
    for (let i = 0; i < fams.length; i++) {
      const token = 'NQF1' + randomToken(24);
      cards.push({ id: newId(), family_id: fams[i].id, family_code: fams[i].family_code, family_label: fams[i].family_label, token, token_hash: await sha256Hex(token), reference: `FC-${String(first + i).padStart(5, '0')}` });
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE family_credentials SET status = 'revoked', revoked_at = ?1, revoked_reason = 'replaced by new card' WHERE tenant_id = ?2 AND status = 'active' AND family_id IN (SELECT value FROM json_each(?3))")
        .bind(now, ctx.tenantId, JSON.stringify(fams.map((f) => f.id))),
      env.DB.prepare(`INSERT INTO family_credentials (id, tenant_id, family_id, token_hash, reference, created_by, created_at)
        SELECT json_extract(value,'$.id'), ?1, json_extract(value,'$.family_id'), json_extract(value,'$.token_hash'), json_extract(value,'$.reference'), ?2, ?3 FROM json_each(?4)`)
        .bind(ctx.tenantId, ctx.user.id, now, JSON.stringify(cards.map(({ token, ...c }) => c))),
      await audit(env, ctx, 'family_credential.issue', 'families', null, { count: cards.length, references: cards.map((c) => c.reference) }),
    ]);
    return json({ cards: cards.map(({ token_hash, ...c }) => c) });
  }],
  ['POST', '/api/family-credentials/:id/revoke', async ({ request, env, ctx, params }) => {
    require(ctx, 'family.credentials');
    const b = await readJson(request);
    const reason = str(b.reason, { required: true, name: 'Reason', max: 300 });
    const res = await env.DB.batch([
      env.DB.prepare("UPDATE family_credentials SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE id = ? AND tenant_id = ? AND status = 'active'").bind(nowIso(), reason, params.id, ctx.tenantId),
      await audit(env, ctx, 'family_credential.revoke', 'family_credential', params.id, null, reason),
    ]);
    if (!res[0].meta.changes) throw conflict('Card not found or already revoked.');
    return json({ ok: true });
  }],
];
export { dateField };
