// Generic, tenant-scoped CRUD for master-data entities. Every reference is checked to
// belong to the caller's school, updates use optimistic concurrency (version), and
// records are archived rather than deleted.
import { bad, conflict, forbidden, json, newId, notFound, nowIso, paging, readJson, str, dateField, code as codeField, emailField, oneOf, intField } from '../lib/util.js';
import { audit, classScope, require } from '../lib/auth.js';

const STATUS = ['active', 'archived'];
const E = {
  campuses: {
    table: 'campuses', view: 'academic.view', manage: 'tenant.configure', order: 't.code', search: ['t.code', 't.name_en', 't.name_ar'],
    fields: { code: { kind: 'code', required: true }, name_en: { kind: 'text', required: true }, name_ar: { kind: 'text' }, address: { kind: 'text', max: 400 }, phone: { kind: 'text', max: 30 }, email: { kind: 'email' } },
  },
  'academic-years': {
    table: 'academic_years', view: 'academic.view', manage: 'academic.manage', order: 't.start_date DESC', search: ['t.code', 't.label'],
    fields: { code: { kind: 'code', required: true }, label: { kind: 'text' }, start_date: { kind: 'date', required: true }, end_date: { kind: 'date', required: true }, is_current: { kind: 'bool' } },
    check: (v) => v.start_date && v.end_date && v.start_date > v.end_date && 'End date must be on or after the start date.',
  },
  terms: {
    table: 'terms', view: 'academic.view', manage: 'academic.manage', order: 't.start_date', search: ['t.code', 't.name_en'],
    select: ', ay.code AS academic_year_code', joins: 'LEFT JOIN academic_years ay ON ay.id = t.academic_year_id',
    fields: { academic_year_id: { kind: 'ref', ref: 'academic_years', required: true }, code: { kind: 'code', required: true }, name_en: { kind: 'text' }, name_ar: { kind: 'text' }, start_date: { kind: 'date', required: true }, end_date: { kind: 'date', required: true } },
    check: (v) => v.start_date && v.end_date && v.start_date > v.end_date && 'End date must be on or after the start date.',
  },
  'timing-groups': {
    table: 'timing_groups', view: 'academic.view', manage: 'academic.manage', order: 't.code', search: ['t.code', 't.name_en'], noStatus: true,
    fields: { code: { kind: 'code', required: true }, name_en: { kind: 'text', required: true }, name_ar: { kind: 'text' }, day_start: { kind: 'time' }, day_end: { kind: 'time' } },
  },
  'year-groups': {
    table: 'year_groups', view: 'academic.view', manage: 'academic.manage', order: 't.sort_order, t.code', search: ['t.code', 't.name_en'],
    select: ', tg.code AS timing_group_code', joins: 'LEFT JOIN timing_groups tg ON tg.id = t.timing_group_id',
    fields: { code: { kind: 'code', required: true }, name_en: { kind: 'text', required: true }, name_ar: { kind: 'text' }, sort_order: { kind: 'int' }, timing_group_id: { kind: 'ref', ref: 'timing_groups' } },
  },
  departments: {
    table: 'departments', view: 'staff.view', manage: 'staff.manage', order: 't.code', search: ['t.code', 't.name_en'],
    fields: { code: { kind: 'code', required: true }, name_en: { kind: 'text', required: true }, name_ar: { kind: 'text' }, campus_id: { kind: 'ref', ref: 'campuses' } },
  },
  subjects: {
    table: 'subjects', view: 'academic.view', manage: 'academic.manage', order: 't.code', search: ['t.code', 't.name_en', 't.name_ar'],
    select: ', d.code AS department_code', joins: 'LEFT JOIN departments d ON d.id = t.department_id',
    fields: { code: { kind: 'code', required: true }, name_en: { kind: 'text', required: true }, name_ar: { kind: 'text' }, department_id: { kind: 'ref', ref: 'departments' }, policy_reference: { kind: 'text' } },
  },
  classes: {
    table: 'classes', view: 'academic.view', manage: 'academic.manage', order: 'yg.sort_order, t.code', search: ['t.code', 't.name_en', 't.name_ar', 't.room_code'], scoped: true,
    select: `, ay.code AS academic_year_code, c.code AS campus_code, yg.code AS year_group_code, tg.code AS timing_group_code,
      s.official_name_en AS class_teacher_name,
      (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = t.id AND e.enrollment_status = 'active') AS enrolled`,
    joins: `LEFT JOIN academic_years ay ON ay.id = t.academic_year_id LEFT JOIN campuses c ON c.id = t.campus_id
      LEFT JOIN year_groups yg ON yg.id = t.year_group_id LEFT JOIN timing_groups tg ON tg.id = yg.timing_group_id
      LEFT JOIN staff s ON s.id = t.class_teacher_staff_id`,
    filters: { academic_year_id: 't.academic_year_id', campus_id: 't.campus_id' },
    fields: {
      academic_year_id: { kind: 'ref', ref: 'academic_years', required: true }, campus_id: { kind: 'ref', ref: 'campuses', required: true },
      year_group_id: { kind: 'ref', ref: 'year_groups' }, code: { kind: 'code', required: true }, name_en: { kind: 'text' }, name_ar: { kind: 'text' },
      room_code: { kind: 'text', max: 40 }, capacity: { kind: 'int' }, class_teacher_staff_id: { kind: 'ref', ref: 'staff' },
    },
  },
  staff: {
    table: 'staff', view: 'staff.view', manage: 'staff.manage', order: 't.official_name_en', search: ['t.staff_code', 't.official_name_en', 't.official_name_ar', 't.work_email', 't.job_title'],
    select: ', d.code AS department_code, c.code AS campus_code, u.email AS user_email', joins: 'LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN campuses c ON c.id = t.campus_id LEFT JOIN users u ON u.id = t.user_id',
    statusValues: ['active', 'on_leave', 'left', 'archived'],
    fields: {
      staff_code: { kind: 'code', required: true }, official_name_en: { kind: 'text', required: true }, official_name_ar: { kind: 'text' }, work_email: { kind: 'email' },
      job_title: { kind: 'text' }, department_id: { kind: 'ref', ref: 'departments' }, campus_id: { kind: 'ref', ref: 'campuses' },
      employment_start: { kind: 'date' }, employment_end: { kind: 'date' },
    },
  },
  'teaching-assignments': {
    table: 'teaching_assignments', view: 'staff.view', manage: 'staff.manage', order: 'cl.code, sub.code', search: ['s.official_name_en', 'cl.code', 'sub.code'], noStatus: true, deletable: true,
    select: ', s.staff_code, s.official_name_en AS staff_name, cl.code AS class_code, sub.code AS subject_code, ay.code AS academic_year_code',
    joins: 'LEFT JOIN staff s ON s.id = t.staff_id LEFT JOIN classes cl ON cl.id = t.class_id LEFT JOIN subjects sub ON sub.id = t.subject_id LEFT JOIN academic_years ay ON ay.id = t.academic_year_id',
    filters: { staff_id: 't.staff_id', class_id: 't.class_id' },
    fields: {
      staff_id: { kind: 'ref', ref: 'staff', required: true }, academic_year_id: { kind: 'ref', ref: 'academic_years', required: true },
      class_id: { kind: 'ref', ref: 'classes', required: true }, subject_id: { kind: 'ref', ref: 'subjects', required: true },
      valid_from: { kind: 'date' }, valid_to: { kind: 'date' }, weekly_load: { kind: 'int' }, lead_teacher: { kind: 'bool' },
    },
  },
  families: {
    table: 'families', view: 'family.view', manage: 'family.manage', order: 't.family_code', search: ['t.family_code', 't.family_label'],
    select: `, (SELECT COUNT(DISTINCT sg.student_id) FROM student_guardians sg WHERE sg.family_id = t.id) AS children,
      (SELECT COUNT(*) FROM family_credentials fc WHERE fc.family_id = t.id AND fc.status = 'active') AS active_cards`,
    fields: { family_code: { kind: 'code', required: true }, family_label: { kind: 'text' }, preferred_language: { kind: 'enum', values: ['en', 'ar'] } },
  },
  guardians: {
    table: 'guardians', view: 'family.view', manage: 'family.manage', order: 't.official_name_en', search: ['t.guardian_code', 't.official_name_en', 't.official_name_ar', 't.email', 't.phone'],
    select: ', u.email AS portal_user', joins: 'LEFT JOIN users u ON u.id = t.user_id',
    fields: {
      guardian_code: { kind: 'code', required: true }, official_name_en: { kind: 'text', required: true }, official_name_ar: { kind: 'text' },
      email: { kind: 'email' }, phone: { kind: 'text', max: 30 }, preferred_language: { kind: 'enum', values: ['en', 'ar'] }, address: { kind: 'text', max: 400 },
      verified_contact_status: { kind: 'enum', values: ['unverified', 'verified'] },
    },
  },
};

async function parse(env, ctx, def, body, partial) {
  const out = {};
  for (const [name, f] of Object.entries(def.fields)) {
    if (partial && !(name in body)) continue;
    const v = body[name];
    const opt = { required: f.required, name: name.replace(/_/g, ' ') };
    switch (f.kind) {
      case 'code': out[name] = codeField(v, opt); break;
      case 'text': out[name] = str(v, { ...opt, max: f.max || 200 }); break;
      case 'date': out[name] = dateField(v, opt); break;
      case 'email': out[name] = emailField(v, opt); break;
      case 'enum': out[name] = oneOf(v, f.values, opt); break;
      case 'int': out[name] = intField(v, { name: opt.name }); break;
      case 'bool': out[name] = v ? 1 : 0; break;
      case 'time': { const s = str(v, { ...opt, max: 5 }); if (s && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw bad(`${opt.name} must be HH:MM.`); out[name] = s; break; }
      case 'ref': {
        const id = str(v, { ...opt, max: 64 });
        // Tenant isolation: a reference must belong to the caller's school.
        if (id && !(await env.DB.prepare(`SELECT 1 FROM ${f.ref} WHERE id = ? AND tenant_id = ?`).bind(id, ctx.tenantId).first())) throw bad(`${opt.name} was not found in this school.`);
        out[name] = id;
        break;
      }
    }
  }
  if (def.check) { const m = def.check(out); if (m) throw bad(m); }
  return out;
}

const routes = [];
for (const [path, def] of Object.entries(E)) {
  const base = `/api/${path}`;
  routes.push(['GET', base, async ({ env, ctx, url }) => {
    require(ctx, def.view);
    const { size, offset } = paging(url);
    const where = ['t.tenant_id = ?'];
    const args = [ctx.tenantId];
    const q = (url.searchParams.get('q') || '').trim();
    if (q) { where.push('(' + def.search.map((c) => `${c} LIKE ?`).join(' OR ') + ')'); def.search.forEach(() => args.push(`%${q}%`)); }
    const status = url.searchParams.get('status');
    if (!def.noStatus) {
      if (status && status !== 'all') { where.push('t.status = ?'); args.push(status); } else if (!status) where.push("t.status != 'archived'");
    }
    for (const [param, col] of Object.entries(def.filters || {})) {
      const v = url.searchParams.get(param);
      if (v) { where.push(`${col} = ?`); args.push(v); }
    }
    if (def.scoped) {
      const scope = await classScope(env, ctx);
      if (scope) { where.push('t.id IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(scope)); }
    }
    const sql = `FROM ${def.table} t ${def.joins || ''} WHERE ${where.join(' AND ')}`;
    const rows = (await env.DB.prepare(`SELECT t.* ${def.select || ''} ${sql} ORDER BY ${def.order} LIMIT ${size} OFFSET ${offset}`).bind(...args).all()).results;
    const total = await env.DB.prepare(`SELECT COUNT(*) AS c ${sql}`).bind(...args).first();
    return json({ rows, total: total.c });
  }]);

  routes.push(['POST', base, async ({ request, env, ctx }) => {
    require(ctx, def.manage);
    const v = await parse(env, ctx, def, await readJson(request), false);
    const id = newId();
    const now = nowIso();
    const cols = Object.keys(v);
    const stmts = [
      env.DB.prepare(`INSERT INTO ${def.table} (id, tenant_id, ${cols.join(', ')}, created_at, updated_at) VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?, ?)`)
        .bind(id, ctx.tenantId, ...cols.map((c) => v[c]), now, now),
      await audit(env, ctx, `${def.table}.create`, def.table, id, v),
    ];
    if (def.table === 'academic_years' && v.is_current) stmts.push(env.DB.prepare('UPDATE academic_years SET is_current = CASE WHEN id = ?2 THEN 1 ELSE 0 END WHERE tenant_id = ?1').bind(ctx.tenantId, id));
    await env.DB.batch(stmts);
    return json({ id }, 201);
  }]);

  routes.push(['PUT', `${base}/:id`, async ({ request, env, ctx, params }) => {
    require(ctx, def.manage);
    const body = await readJson(request);
    const cur = await env.DB.prepare(`SELECT * FROM ${def.table} WHERE id = ? AND tenant_id = ?`).bind(params.id, ctx.tenantId).first();
    if (!cur) throw notFound();
    const v = await parse(env, ctx, def, { ...cur, ...body }, false);
    if (!def.noStatus && body.status !== undefined) v.status = oneOf(body.status, def.statusValues || STATUS, { name: 'status' });
    const changes = Object.fromEntries(Object.entries(v).filter(([k, x]) => cur[k] !== x && !(cur[k] == null && x == null)));
    if (!Object.keys(changes).length) return json({ ok: true, unchanged: true, version: cur.version });
    const cols = Object.keys(changes);
    const stmts = [
      env.DB.prepare(`UPDATE ${def.table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ? AND tenant_id = ? AND version = ?`)
        .bind(...cols.map((c) => changes[c]), nowIso(), cur.id, ctx.tenantId, Number(body.version)),
      await audit(env, ctx, `${def.table}.update`, def.table, cur.id, Object.fromEntries(cols.map((c) => [c, { from: cur[c], to: changes[c] }]))),
    ];
    if (def.table === 'academic_years' && changes.is_current) stmts.push(env.DB.prepare('UPDATE academic_years SET is_current = CASE WHEN id = ?2 THEN 1 ELSE 0 END WHERE tenant_id = ?1').bind(ctx.tenantId, cur.id));
    const res = await env.DB.batch(stmts);
    if (!res[0].meta.changes) throw conflict('This record was changed by someone else. Reload to see the latest version, then re-apply your edit.', { current_version: cur.version });
    return json({ ok: true, version: cur.version + 1 });
  }]);

  if (!def.noStatus) {
    routes.push(['POST', `${base}/:id/archive`, async ({ request, env, ctx, params }) => {
      require(ctx, def.manage);
      const b = await readJson(request);
      const restore = !!b.restore;
      const res = await env.DB.batch([
        env.DB.prepare(`UPDATE ${def.table} SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND tenant_id = ?`).bind(restore ? 'active' : 'archived', nowIso(), params.id, ctx.tenantId),
        await audit(env, ctx, `${def.table}.${restore ? 'restore' : 'archive'}`, def.table, params.id, null, str(b.reason, { max: 300 })),
      ]);
      if (!res[0].meta.changes) throw notFound();
      return json({ ok: true });
    }]);
  }
  if (def.deletable) {
    routes.push(['DELETE', `${base}/:id`, async ({ env, ctx, params }) => {
      require(ctx, def.manage);
      const res = await env.DB.batch([
        env.DB.prepare(`DELETE FROM ${def.table} WHERE id = ? AND tenant_id = ?`).bind(params.id, ctx.tenantId),
        await audit(env, ctx, `${def.table}.delete`, def.table, params.id),
      ]);
      if (!res[0].meta.changes) throw notFound();
      return json({ ok: true });
    }]);
  }
}
export default routes;
export { forbidden };
