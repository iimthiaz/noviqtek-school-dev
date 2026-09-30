import { bad, conflict, forbidden, json, newId, notFound, nowIso, paging, readJson, str, dateField, code as codeField, emailField, oneOf, localDate } from '../lib/util.js';
import { audit, can, classScope, require } from '../lib/auth.js';
import { toCsv } from '../lib/csv.js';

const REL = ['mother', 'father', 'parent', 'legal_guardian', 'grandparent', 'sibling', 'other'];
const STUDENT_STATUS = ['active', 'withdrawn', 'graduated', 'archived'];

function parseStudent(b, partialOf) {
  const src = partialOf ? { ...partialOf, ...b } : b;
  return {
    admission_no: codeField(src.admission_no, { name: 'Admission number' }),
    official_name_en: str(src.official_name_en, { required: true, name: 'Official name (English)' }),
    official_name_ar: str(src.official_name_ar, { name: 'Official name (Arabic)' }),
    preferred_name: str(src.preferred_name, { name: 'Preferred name' }),
    date_of_birth: dateField(src.date_of_birth, { required: true, name: 'Date of birth' }),
    gender_code: oneOf(src.gender_code, ['M', 'F'], { name: 'Gender' }),
    nationality_code: str(src.nationality_code, { max: 3, name: 'Nationality' }),
    school_email: emailField(src.school_email, { name: 'School email' }),
    joined_date: dateField(src.joined_date, { name: 'Joined date' }),
    status: oneOf(src.status || 'active', STUDENT_STATUS, { name: 'Status' }),
  };
}

// Students visible to this user: all, or only those actively enrolled in scoped classes.
async function scopeClause(env, ctx) {
  const scope = await classScope(env, ctx);
  if (!scope) return { sql: '', args: [] };
  return { sql: " AND s.id IN (SELECT e.student_id FROM enrollments e WHERE e.enrollment_status = 'active' AND e.class_id IN (SELECT value FROM json_each(?)))", args: [JSON.stringify(scope)] };
}
export async function assertStudentInScope(env, ctx, studentId) {
  const sc = await scopeClause(env, ctx);
  const r = await env.DB.prepare(`SELECT s.id FROM students s WHERE s.id = ? AND s.tenant_id = ?${sc.sql}`).bind(studentId, ctx.tenantId, ...sc.args).first();
  if (!r) throw notFound('Student not found or not in your assigned classes.');
}

async function listQuery(env, ctx, url) {
  const where = ['s.tenant_id = ?'];
  const args = [ctx.tenantId];
  const q = (url.searchParams.get('q') || '').trim();
  if (q) { where.push('(s.admission_no LIKE ? OR s.official_name_en LIKE ? OR s.official_name_ar LIKE ? OR s.preferred_name LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const status = url.searchParams.get('status') || 'active';
  if (status !== 'all') { where.push('s.status = ?'); args.push(status); }
  const classId = url.searchParams.get('class_id');
  if (classId) { where.push("s.id IN (SELECT student_id FROM enrollments WHERE class_id = ? AND enrollment_status = 'active')"); args.push(classId); }
  const sc = await scopeClause(env, ctx);
  const sortMap = { name: 's.official_name_en', admission_no: 's.admission_no', class: 'class_code, s.official_name_en', dob: 's.date_of_birth' };
  const sort = sortMap[url.searchParams.get('sort')] || 's.official_name_en';
  const dir = url.searchParams.get('dir') === 'desc' ? 'DESC' : 'ASC';
  return {
    from: `FROM students s WHERE ${where.join(' AND ')}${sc.sql}`,
    args: [...args, ...sc.args],
    select: `SELECT s.*, (SELECT c.code FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = s.id AND e.enrollment_status = 'active' ORDER BY e.start_date DESC LIMIT 1) AS class_code,
      (SELECT c.id FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = s.id AND e.enrollment_status = 'active' ORDER BY e.start_date DESC LIMIT 1) AS class_id`,
    order: `ORDER BY ${sort} ${dir}`,
  };
}

export default [
  ['GET', '/api/students', async ({ env, ctx, url }) => {
    require(ctx, 'student.view');
    const { size, offset } = paging(url);
    const q = await listQuery(env, ctx, url);
    const rows = (await env.DB.prepare(`${q.select} ${q.from} ${q.order} LIMIT ${size} OFFSET ${offset}`).bind(...q.args).all()).results;
    const total = await env.DB.prepare(`SELECT COUNT(*) c ${q.from}`).bind(...q.args).first();
    return json({ rows, total: total.c });
  }],

  ['GET', '/api/students/export', async ({ env, ctx, url }) => {
    require(ctx, 'student.view', 'student.export');
    const q = await listQuery(env, ctx, url);
    const rows = (await env.DB.prepare(`${q.select} ${q.from} ${q.order} LIMIT 20000`).bind(...q.args).all()).results;
    const cols = ['admission_no', 'official_name_en', 'official_name_ar', 'preferred_name', 'date_of_birth', 'gender_code', 'nationality_code', 'class_code', 'status', 'school_email', 'joined_date'];
    await (await audit(env, ctx, 'students.export', 'students', null, { rows: rows.length, filters: Object.fromEntries(url.searchParams) })).run();
    return new Response(toCsv(cols, rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="students-${localDate(ctx.tenant.timezone)}.csv"`, 'Cache-Control': 'no-store' } });
  }],

  ['GET', '/api/students/:id', async ({ env, ctx, params }) => {
    require(ctx, 'student.view');
    await assertStudentInScope(env, ctx, params.id);
    const s = await env.DB.prepare('SELECT * FROM students WHERE id = ? AND tenant_id = ?').bind(params.id, ctx.tenantId).first();
    const enrollments = (await env.DB.prepare(
      `SELECT e.*, c.code AS class_code, ay.code AS academic_year_code, cp.code AS campus_code FROM enrollments e
        JOIN classes c ON c.id = e.class_id JOIN academic_years ay ON ay.id = e.academic_year_id JOIN campuses cp ON cp.id = e.campus_id
        WHERE e.student_id = ? AND e.tenant_id = ? ORDER BY e.start_date DESC`
    ).bind(s.id, ctx.tenantId).all()).results;
    let guardians = null;
    if (can(ctx, 'family.view')) {
      guardians = (await env.DB.prepare(
        `SELECT sg.*, g.guardian_code, g.official_name_en, g.official_name_ar, g.phone, g.email, f.family_code FROM student_guardians sg
          JOIN guardians g ON g.id = sg.guardian_id LEFT JOIN families f ON f.id = sg.family_id
          WHERE sg.student_id = ? AND sg.tenant_id = ? ORDER BY sg.emergency_priority IS NULL, sg.emergency_priority`
      ).bind(s.id, ctx.tenantId).all()).results;
    }
    return json({ student: s, enrollments, guardians });
  }],

  ['POST', '/api/students', async ({ request, env, ctx }) => {
    require(ctx, 'student.create');
    const v = parseStudent(await readJson(request));
    if (!v.admission_no) throw bad('Admission number is required.');
    const id = newId('s_');
    const now = nowIso();
    const cols = Object.keys(v);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO students (id, tenant_id, ${cols.join(',')}, created_at, updated_at) VALUES (?,?,${cols.map(() => '?').join(',')},?,?)`).bind(id, ctx.tenantId, ...cols.map((c) => v[c]), now, now),
      await audit(env, ctx, 'student.create', 'student', id, { admission_no: v.admission_no }),
    ]);
    return json({ id }, 201);
  }],

  // Admission number is an editable attribute; the immutable internal id keeps every relationship intact.
  ['PUT', '/api/students/:id', async ({ request, env, ctx, params }) => {
    require(ctx, 'student.edit');
    await assertStudentInScope(env, ctx, params.id);
    const b = await readJson(request);
    const cur = await env.DB.prepare('SELECT * FROM students WHERE id = ? AND tenant_id = ?').bind(params.id, ctx.tenantId).first();
    const v = parseStudent(b, cur);
    if (!v.admission_no) throw bad('Admission number is required.');
    if (v.status === 'archived' && cur.status !== 'archived' && !can(ctx, 'student.archive')) throw forbidden('You cannot archive students.');
    const changes = Object.fromEntries(Object.entries(v).filter(([k, x]) => cur[k] !== x && !(cur[k] == null && x == null)));
    if (!Object.keys(changes).length) return json({ ok: true, unchanged: true, version: cur.version });
    const cols = Object.keys(changes);
    const res = await env.DB.batch([
      env.DB.prepare(`UPDATE students SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ? AND tenant_id = ? AND version = ?`)
        .bind(...cols.map((c) => changes[c]), nowIso(), cur.id, ctx.tenantId, Number(b.version)),
      await audit(env, ctx, 'student.update', 'student', cur.id, Object.fromEntries(cols.map((c) => [c, { from: cur[c], to: changes[c] }])), str(b.reason, { max: 300 })),
    ]);
    if (!res[0].meta.changes) throw conflict('This student was changed by someone else. Your text is kept; reload the latest version and re-apply.', { current_version: cur.version });
    return json({ ok: true, version: cur.version + 1 });
  }],

  ['POST', '/api/students/:id/archive', async ({ request, env, ctx, params }) => {
    require(ctx, 'student.archive');
    const b = await readJson(request);
    const res = await env.DB.batch([
      env.DB.prepare('UPDATE students SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND tenant_id = ?').bind(b.restore ? 'active' : 'archived', nowIso(), params.id, ctx.tenantId),
      await audit(env, ctx, b.restore ? 'student.restore' : 'student.archive', 'student', params.id, null, str(b.reason, { max: 300 })),
    ]);
    if (!res[0].meta.changes) throw notFound();
    return json({ ok: true });
  }],

  ['POST', '/api/students/:id/enrollments', async ({ request, env, ctx, params }) => {
    require(ctx, 'student.edit');
    const b = await readJson(request);
    const s = await env.DB.prepare('SELECT id FROM students WHERE id = ? AND tenant_id = ?').bind(params.id, ctx.tenantId).first();
    if (!s) throw notFound();
    const cls = await env.DB.prepare('SELECT * FROM classes WHERE id = ? AND tenant_id = ?').bind(b.class_id, ctx.tenantId).first();
    if (!cls) throw bad('Class not found in this school.');
    const start = dateField(b.start_date, { required: true, name: 'Start date' });
    const cnt = await env.DB.prepare("SELECT COUNT(*) c FROM enrollments WHERE class_id = ? AND enrollment_status = 'active'").bind(cls.id).first();
    if (cls.capacity && cnt.c >= cls.capacity && !b.override_capacity) throw conflict(`Class ${cls.code} is at capacity (${cls.capacity}).`, { at_capacity: true });
    const now = nowIso();
    const id = newId();
    // Moving class within a year ends the previous active enrollment the day before.
    const prevEnd = new Date(Date.parse(start + 'T00:00:00Z') - 86400e3).toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare("UPDATE enrollments SET enrollment_status = 'ended', end_date = COALESCE(end_date, ?), updated_at = ?, version = version + 1 WHERE student_id = ? AND tenant_id = ? AND academic_year_id = ? AND enrollment_status = 'active'")
        .bind(prevEnd, now, s.id, ctx.tenantId, cls.academic_year_id),
      env.DB.prepare("INSERT INTO enrollments (id, tenant_id, student_id, academic_year_id, campus_id, class_id, start_date, enrollment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'active',?,?)")
        .bind(id, ctx.tenantId, s.id, cls.academic_year_id, cls.campus_id, cls.id, start, now, now),
      await audit(env, ctx, 'enrollment.create', 'student', s.id, { class: cls.code, start_date: start }),
    ]);
    return json({ id }, 201);
  }],

  ['POST', '/api/students/:id/guardians', async ({ request, env, ctx, params }) => {
    require(ctx, 'family.manage');
    const b = await readJson(request);
    const s = await env.DB.prepare('SELECT id FROM students WHERE id = ? AND tenant_id = ?').bind(params.id, ctx.tenantId).first();
    const g = await env.DB.prepare('SELECT id FROM guardians WHERE id = ? AND tenant_id = ?').bind(b.guardian_id, ctx.tenantId).first();
    if (!s || !g) throw bad('Student or guardian not found in this school.');
    let familyId = null;
    if (b.family_id) {
      const f = await env.DB.prepare('SELECT id FROM families WHERE id = ? AND tenant_id = ?').bind(b.family_id, ctx.tenantId).first();
      if (!f) throw bad('Family not found in this school.');
      familyId = f.id;
    }
    const v = {
      relationship_code: oneOf(b.relationship_code, REL, { required: true, name: 'Relationship' }),
      portal_access: b.portal_access ? 1 : 0, pickup_authorized: b.pickup_authorized ? 1 : 0, billing_contact: b.billing_contact ? 1 : 0,
      emergency_priority: b.emergency_priority ? Number(b.emergency_priority) | 0 : null,
      valid_from: dateField(b.valid_from), valid_to: dateField(b.valid_to),
    };
    const now = nowIso();
    const id = newId();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO student_guardians (id, tenant_id, student_id, guardian_id, family_id, relationship_code, portal_access, pickup_authorized, billing_contact, emergency_priority, valid_from, valid_to, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (tenant_id, student_id, guardian_id) DO UPDATE SET family_id = excluded.family_id, relationship_code = excluded.relationship_code, portal_access = excluded.portal_access,
          pickup_authorized = excluded.pickup_authorized, billing_contact = excluded.billing_contact, emergency_priority = excluded.emergency_priority,
          valid_from = excluded.valid_from, valid_to = excluded.valid_to, updated_at = excluded.updated_at, version = student_guardians.version + 1`)
        .bind(id, ctx.tenantId, s.id, g.id, familyId, v.relationship_code, v.portal_access, v.pickup_authorized, v.billing_contact, v.emergency_priority, v.valid_from, v.valid_to, now, now),
      await audit(env, ctx, 'student_guardian.upsert', 'student', s.id, { guardian_id: g.id, family_id: familyId, ...v }),
    ]);
    return json({ ok: true });
  }],

  ['POST', '/api/student-guardians/:id/end', async ({ request, env, ctx, params }) => {
    require(ctx, 'family.manage');
    const b = await readJson(request);
    const yesterday = new Date(Date.parse(localDate(ctx.tenant.timezone) + 'T00:00:00Z') - 86400e3).toISOString().slice(0, 10);
    const res = await env.DB.batch([
      env.DB.prepare('UPDATE student_guardians SET valid_to = ?, portal_access = 0, pickup_authorized = 0, updated_at = ?, version = version + 1 WHERE id = ? AND tenant_id = ?').bind(yesterday, nowIso(), params.id, ctx.tenantId),
      await audit(env, ctx, 'student_guardian.end', 'student_guardians', params.id, null, str(b.reason, { max: 300 })),
    ]);
    if (!res[0].meta.changes) throw notFound();
    return json({ ok: true });
  }],

  // Parent portal: only children explicitly linked with portal access, within validity dates.
  ['GET', '/api/portal/children', async ({ env, ctx }) => {
    if (!ctx.guardianId) return json({ children: [] });
    const today = localDate(ctx.tenant.timezone);
    const rows = (await env.DB.prepare(
      `SELECT s.id, s.admission_no, s.official_name_en, s.official_name_ar, s.preferred_name,
        (SELECT c.code FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = s.id AND e.enrollment_status = 'active' LIMIT 1) AS class_code,
        (SELECT status_code FROM attendance a WHERE a.student_id = s.id AND a.attendance_date = ?3 AND a.session_code = 'DAY') AS attendance_today,
        (SELECT status FROM dismissal_records d WHERE d.student_id = s.id AND d.dismissal_date = ?3) AS dismissal_today
       FROM student_guardians sg JOIN students s ON s.id = sg.student_id
       WHERE sg.guardian_id = ?1 AND sg.tenant_id = ?2 AND sg.portal_access = 1 AND s.status = 'active'
         AND (sg.valid_from IS NULL OR sg.valid_from <= ?3) AND (sg.valid_to IS NULL OR sg.valid_to >= ?3)
       ORDER BY s.official_name_en`
    ).bind(ctx.guardianId, ctx.tenantId, today).all()).results;
    return json({ children: rows, date: today });
  }],
];
