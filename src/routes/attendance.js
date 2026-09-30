import { bad, forbidden, json, newId, nowIso, readJson, str, dateField, localDate, notFound } from '../lib/util.js';
import { audit, assertClassInScope, can, classScope, require } from '../lib/auth.js';
import { toCsv } from '../lib/csv.js';

const STATUSES = ['present', 'absent', 'late', 'excused'];

// Students enrolled in a class on a given date (enrollment effective dates respected).
function rosterSql() {
  return `SELECT s.id AS student_id, s.admission_no, s.official_name_en, s.official_name_ar, s.preferred_name,
      a.id AS attendance_id, a.status_code, a.minutes_late, a.reason_code, a.note, a.recorded_at, a.version,
      u.display_name AS recorded_by_name
    FROM enrollments e JOIN students s ON s.id = e.student_id
    LEFT JOIN attendance a ON a.student_id = s.id AND a.attendance_date = ?2 AND a.session_code = ?3 AND a.tenant_id = e.tenant_id
    LEFT JOIN users u ON u.id = a.recorded_by
    WHERE e.class_id = ?1 AND e.tenant_id = ?4 AND e.start_date <= ?2 AND (e.end_date IS NULL OR e.end_date >= ?2)
      AND e.enrollment_status IN ('active','ended','transferred') AND s.status != 'archived'
    ORDER BY s.official_name_en`;
}

export default [
  ['GET', '/api/attendance/register', async ({ env, ctx, url }) => {
    require(ctx, 'attendance.view');
    const classId = url.searchParams.get('class_id');
    const date = dateField(url.searchParams.get('date') || localDate(ctx.tenant.timezone), { name: 'date' });
    const session = (url.searchParams.get('session') || 'DAY').slice(0, 20);
    const cls = await env.DB.prepare('SELECT id, code, name_en, name_ar FROM classes WHERE id = ? AND tenant_id = ?').bind(classId, ctx.tenantId).first();
    if (!cls) throw notFound('Class not found.');
    await assertClassInScope(env, ctx, cls.id);
    const rows = (await env.DB.prepare(rosterSql()).bind(cls.id, date, session, ctx.tenantId).all()).results;
    const today = localDate(ctx.tenant.timezone);
    return json({
      class: cls, date, session, rows, today,
      can_record: can(ctx, 'attendance.record') && date <= today,
      can_correct: can(ctx, 'attendance.correct'),
      working_day: ctx.tenant.working_days.split(',').includes(String(new Date(date + 'T12:00:00Z').getUTCDay())),
    });
  }],

  ['POST', '/api/attendance/register', async ({ request, env, ctx }) => {
    require(ctx, 'attendance.record');
    const b = await readJson(request);
    const date = dateField(b.date, { required: true, name: 'date' });
    const session = String(b.session_code || 'DAY').slice(0, 20);
    const today = localDate(ctx.tenant.timezone);
    if (date > today) throw bad('Attendance cannot be recorded for a future date.');
    const cls = await env.DB.prepare('SELECT id, code FROM classes WHERE id = ? AND tenant_id = ?').bind(b.class_id, ctx.tenantId).first();
    if (!cls) throw notFound('Class not found.');
    await assertClassInScope(env, ctx, cls.id);
    if (!Array.isArray(b.marks) || !b.marks.length) throw bad('No attendance marks were submitted.');
    const roster = new Map((await env.DB.prepare(rosterSql()).bind(cls.id, date, session, ctx.tenantId).all()).results.map((r) => [r.student_id, r]));
    const reason = str(b.reason, { max: 300 });
    const now = nowIso();
    const rows = [];
    const corrections = [];
    for (const m of b.marks) {
      const r = roster.get(m.student_id);
      if (!r) throw bad('A submitted student is not enrolled in this class on this date.');
      if (!STATUSES.includes(m.status_code)) throw bad(`Status must be one of ${STATUSES.join(', ')}.`);
      const minutes = m.status_code === 'late' && m.minutes_late !== undefined && m.minutes_late !== '' && m.minutes_late !== null ? Math.max(0, Math.min(600, Number(m.minutes_late) | 0)) : null;
      const note = str(m.note, { max: 500, name: 'note' });
      if (r.status_code === m.status_code && (r.minutes_late ?? null) === minutes && (r.note ?? null) === note) continue;
      if (r.status_code) {
        // Editing an existing mark: same-day fixes by the register taker; past days need correction rights + reason.
        if (date < today && !can(ctx, 'attendance.correct')) throw forbidden('Correcting attendance for a past date needs the attendance correction permission.');
        if (date < today && !reason) throw bad('A reason is required to correct past attendance.');
        corrections.push({ student_id: m.student_id, from: r.status_code, to: m.status_code });
      }
      rows.push({ id: r.attendance_id || newId(), student_id: m.student_id, status_code: m.status_code, minutes_late: minutes, note, reason_code: str(m.reason_code, { max: 40 }) });
    }
    if (!rows.length) return json({ ok: true, saved: 0 });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO attendance (id, tenant_id, student_id, class_id, attendance_date, session_code, status_code, minutes_late, reason_code, note, recorded_by, recorded_at, created_at, updated_at)
        SELECT json_extract(value,'$.id'), ?1, json_extract(value,'$.student_id'), ?2, ?3, ?4, json_extract(value,'$.status_code'), json_extract(value,'$.minutes_late'),
               json_extract(value,'$.reason_code'), json_extract(value,'$.note'), ?5, ?6, ?6, ?6 FROM json_each(?7) WHERE true
        ON CONFLICT (tenant_id, student_id, attendance_date, session_code) DO UPDATE SET status_code = excluded.status_code, minutes_late = excluded.minutes_late,
          reason_code = excluded.reason_code, note = excluded.note, recorded_by = excluded.recorded_by, recorded_at = excluded.recorded_at,
          class_id = excluded.class_id, updated_at = excluded.updated_at, version = attendance.version + 1`)
        .bind(ctx.tenantId, cls.id, date, session, ctx.user.id, now, JSON.stringify(rows)),
      await audit(env, ctx, corrections.length ? 'attendance.correct' : 'attendance.record', 'class', cls.id, { date, session, saved: rows.length, corrections: corrections.slice(0, 50) }, reason),
    ]);
    return json({ ok: true, saved: rows.length, corrections: corrections.length });
  }],

  // Metric definitions: enrolled = students with an enrollment covering the date;
  // unmarked = enrolled without a record (never counted as present); rate = (present + late) / marked.
  ['GET', '/api/attendance/summary', async ({ env, ctx, url }) => {
    require(ctx, 'attendance.view');
    const date = dateField(url.searchParams.get('date') || localDate(ctx.tenant.timezone), { name: 'date' });
    const session = (url.searchParams.get('session') || 'DAY').slice(0, 20);
    const scope = await classScope(env, ctx);
    const rows = (await env.DB.prepare(
      `SELECT c.id AS class_id, c.code, c.name_en, c.name_ar, yg.sort_order,
        COUNT(e.id) AS enrolled,
        SUM(a.status_code = 'present') AS present, SUM(a.status_code = 'late') AS late,
        SUM(a.status_code = 'absent') AS absent, SUM(a.status_code = 'excused') AS excused,
        SUM(e.id IS NOT NULL AND a.id IS NULL) AS unmarked
       FROM classes c LEFT JOIN year_groups yg ON yg.id = c.year_group_id
       JOIN academic_years ay ON ay.id = c.academic_year_id AND ay.start_date <= ?2 AND ay.end_date >= ?2
       LEFT JOIN enrollments e ON e.class_id = c.id AND e.start_date <= ?2 AND (e.end_date IS NULL OR e.end_date >= ?2) AND e.enrollment_status IN ('active','ended','transferred')
       LEFT JOIN attendance a ON a.student_id = e.student_id AND a.attendance_date = ?2 AND a.session_code = ?3 AND a.tenant_id = c.tenant_id
       WHERE c.tenant_id = ?1 AND c.status = 'active' ${scope ? 'AND c.id IN (SELECT value FROM json_each(?4))' : ''}
       GROUP BY c.id ORDER BY yg.sort_order, c.code`
    ).bind(ctx.tenantId, date, session, ...(scope ? [JSON.stringify(scope)] : [])).all()).results;
    const t = rows.reduce((acc, r) => { for (const k of ['enrolled', 'present', 'late', 'absent', 'excused', 'unmarked']) acc[k] += r[k] || 0; return acc; }, { enrolled: 0, present: 0, late: 0, absent: 0, excused: 0, unmarked: 0 });
    const marked = t.enrolled - t.unmarked;
    return json({
      date, session, classes: rows, totals: { ...t, marked, attendance_rate: marked ? Math.round(((t.present + t.late) / marked) * 1000) / 10 : null },
      definitions: {
        enrolled: 'Students whose enrollment covers this date in an active class.',
        unmarked: 'Enrolled students with no attendance record yet. Never counted as present.',
        attendance_rate: '(present + late) ÷ marked students, as a percentage. Excused counts as marked, not present.',
      },
      generated_at: nowIso(),
    });
  }],

  ['GET', '/api/attendance/export', async ({ env, ctx, url }) => {
    require(ctx, 'attendance.view');
    const from = dateField(url.searchParams.get('from'), { required: true, name: 'from' });
    const to = dateField(url.searchParams.get('to'), { required: true, name: 'to' });
    if (from > to) throw bad('"from" must be on or before "to".');
    const classId = url.searchParams.get('class_id') || '';
    if (classId) await assertClassInScope(env, ctx, classId);
    const scope = await classScope(env, ctx);
    const rows = (await env.DB.prepare(
      `SELECT a.attendance_date, a.session_code, c.code AS class_code, s.admission_no, s.official_name_en, s.official_name_ar,
         a.status_code, a.minutes_late, a.reason_code, a.note, a.recorded_at
       FROM attendance a JOIN students s ON s.id = a.student_id LEFT JOIN classes c ON c.id = a.class_id
       WHERE a.tenant_id = ?1 AND a.attendance_date BETWEEN ?2 AND ?3 AND (?4 = '' OR a.class_id = ?4)
       ${scope ? 'AND a.class_id IN (SELECT value FROM json_each(?5))' : ''}
       ORDER BY a.attendance_date, c.code, s.official_name_en LIMIT 50000`
    ).bind(ctx.tenantId, from, to, classId, ...(scope ? [JSON.stringify(scope)] : [])).all()).results;
    await (await audit(env, ctx, 'attendance.export', 'attendance', null, { from, to, class_id: classId || null, rows: rows.length })).run();
    const cols = ['attendance_date', 'session_code', 'class_code', 'admission_no', 'official_name_en', 'official_name_ar', 'status_code', 'minutes_late', 'reason_code', 'note', 'recorded_at'];
    return new Response(toCsv(cols, rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="attendance-${from}-to-${to}.csv"`, 'Cache-Control': 'no-store' } });
  }],
];
