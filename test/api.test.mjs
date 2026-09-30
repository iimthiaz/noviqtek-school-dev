// Integration + security tests for the Worker API against a D1-compatible SQLite database.
// Run: node --test test/   (Node 22+)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './d1-shim.mjs';
import { handleApi } from '../src/worker.js';
import { totpAt } from '../src/lib/auth.js';
import { sha256Hex } from '../src/lib/util.js';

const env = { DB: createD1(new URL('../migrations', import.meta.url).pathname), AUDIT_KEY: 'test-audit-key' };
const BASE = 'https://school.example.test';

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, path, body) {
    const headers = { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.' + (Math.random() * 200 | 0) };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    const res = await handleApi(new Request(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
  put(p, b) { return this.req('PUT', p, b || {}); }
  async refresh() { const r = await this.get('/api/me'); this.csrf = r.data.csrf; return r.data; }
}

async function setupToken() {
  const token = 'setup-' + Math.random().toString(36).slice(2) + Date.now();
  env.DB.raw.prepare("INSERT INTO one_time_tokens (token_hash, purpose, created_at, expires_at) VALUES (?, 'school_setup', ?, ?)")
    .run(await sha256Hex(token), new Date().toISOString(), new Date(Date.now() + 86400e3).toISOString());
  return token;
}
async function enrolMfa(c) {
  const s = await c.post('/api/mfa/setup');
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const code = await totpAt(s.data.secret, Math.floor(Date.now() / 30000));
  const e = await c.post('/api/mfa/enable', { code });
  assert.equal(e.status, 200, JSON.stringify(e.data));
  return s.data.secret;
}
const PW = 'Correct-Horse-9-Battery';
const S = {};

test('health endpoint', async () => {
  const r = await new Client().get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.schools_configured, false);
});

test('school A setup via one-time link; link cannot be reused', async () => {
  const token = await setupToken();
  const a = new Client();
  const bad = await a.post('/api/setup', { token, school_code: 'DEMOA', name_en: 'Demo School A', admin_name: 'Admin A', admin_email: 'admin.a@example.invalid', password: 'short' });
  assert.equal(bad.status, 400);
  const r = await a.post('/api/setup', { token, school_code: 'DEMOA', name_en: 'Demo School A', name_ar: 'مدرسة تجريبية أ', admin_name: 'Admin A', admin_email: 'admin.a@example.invalid', password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const again = await new Client().post('/api/setup', { token, school_code: 'DEMOX', name_en: 'X', admin_name: 'X', admin_email: 'x@example.invalid', password: PW });
  assert.equal(again.data.error.code, 'TOKEN_USED');
  S.adminA = a;
});

test('administrator must enrol MFA before using the system; CSRF enforced', async () => {
  const a = S.adminA;
  const me = await a.refresh();
  assert.equal(me.needs_mfa_enrollment, true);
  const blocked = await a.get('/api/students');
  assert.equal(blocked.data.error.code, 'MFA_ENROLL_REQUIRED');
  S.mfaA = await enrolMfa(a);
  const noCsrf = new Client(); noCsrf.cookie = a.cookie;
  const r = await noCsrf.post('/api/campuses', { code: 'X', name_en: 'X' });
  assert.equal(r.data.error.code, 'CSRF');
  // Login now requires the TOTP code.
  const c = new Client();
  const step1 = await c.post('/api/login', { email: 'admin.a@example.invalid', password: PW });
  assert.equal(step1.data.mfa_required, true);
  const step2 = await c.post('/api/login', { email: 'admin.a@example.invalid', password: PW, mfa_code: await totpAt(S.mfaA, Math.floor(Date.now() / 30000)) });
  assert.equal(step2.status, 200);
});

test('default structure: Year 1A–6B with two timing groups', async () => {
  const r = await S.adminA.get('/api/classes?size=50');
  assert.equal(r.data.total, 12);
  const y1 = r.data.rows.find((c) => c.code === 'Y1A');
  const y6 = r.data.rows.find((c) => c.code === 'Y6A');
  assert.equal(y1.timing_group_code, 'Y1-2');
  assert.equal(y6.timing_group_code, 'Y3-6');
  S.classes = Object.fromEntries(r.data.rows.map((c) => [c.code, c]));
  S.ay = y1.academic_year_code;
});

async function importRows(c, module, rows, extra = {}) {
  const v = await c.post('/api/imports/validate', { module, mode: 'upsert', rows, ...extra });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  const cm = await c.post('/api/imports/commit', { module, mode: 'upsert', rows, file_hash: v.data.file_hash, file_name: module + '.csv', ...extra });
  return { v: v.data, c: cm };
}

test('import center: departments, staff, students with leading zeros/Arabic, enrollments, families, guardians, links', async () => {
  const a = S.adminA;
  let r = await importRows(a, 'departments', [{ department_code: 'PRIM', department_name_en: 'Primary' }]);
  assert.equal(r.c.status, 200, JSON.stringify(r.c.data));
  r = await importRows(a, 'staff', [
    { staff_code: 'S0001', official_name_en: 'Demo Teacher One', work_email: 'teacher.one@example.invalid', department_code: 'PRIM', campus_code: 'MAIN' },
    { staff_code: 'S0006', official_name_en: 'Demo Teacher Six', work_email: 'teacher.six@example.invalid', department_code: 'PRIM', campus_code: 'MAIN' },
  ]);
  assert.equal(r.c.data.summary.creates, 2);
  r = await importRows(a, 'classes', [
    { academic_year_code: S.ay, campus_code: 'MAIN', year_group_code: 'Y1', class_code: 'Y1A', class_teacher_staff_code: 'S0001' },
    { academic_year_code: S.ay, campus_code: 'MAIN', year_group_code: 'Y6', class_code: 'Y6A', class_teacher_staff_code: 'S0006' },
  ]);
  assert.equal(r.c.data.summary.updates, 2, JSON.stringify(r.c.data));
  const students = [
    { admission_no: '000101', official_name_en: 'Demo Learner One', official_name_ar: 'متعلم تجريبي واحد', date_of_birth: '2018-02-14', status: 'active' },
    { admission_no: '000102', official_name_en: 'Demo Learner Two', date_of_birth: '2013-07-08', status: 'active' },
    { admission_no: '000103', official_name_en: 'Demo Learner Three', date_of_birth: '2018-05-01' },
  ];
  r = await importRows(a, 'students', students);
  assert.equal(r.c.status, 200, JSON.stringify(r.c.data));
  assert.equal(r.c.data.summary.creates, 3);
  const list = await a.get('/api/students?q=000101');
  assert.equal(list.data.rows[0].admission_no, '000101');
  assert.equal(list.data.rows[0].official_name_ar, 'متعلم تجريبي واحد');

  // Re-uploading the same committed file is refused and creates nothing.
  const again = await a.post('/api/imports/commit', { module: 'students', mode: 'upsert', rows: students });
  assert.equal(again.data.error.code, 'ALREADY_COMMITTED');
  assert.equal((await a.get('/api/students?status=all')).data.total, 3);

  const today = new Date().toISOString().slice(0, 10);
  const start = S.classes.Y1A && (await a.get('/api/academic-years')).data.rows[0].start_date;
  r = await importRows(a, 'enrollments', [
    { admission_no: '000101', academic_year_code: S.ay, campus_code: 'MAIN', class_code: 'Y1A', start_date: start },
    { admission_no: '000102', academic_year_code: S.ay, campus_code: 'MAIN', class_code: 'Y6A', start_date: start },
    { admission_no: '000103', academic_year_code: S.ay, campus_code: 'MAIN', class_code: 'Y1A', start_date: start },
  ]);
  assert.equal(r.c.data.summary.creates, 3, JSON.stringify(r.c.data));
  r = await importRows(a, 'families', [{ family_code: 'F001', family_label: 'Demo Family' }]);
  r = await importRows(a, 'guardians', [{ guardian_code: 'G001', official_name_en: 'Demo Guardian One', phone: '+974 5000 0000' }, { guardian_code: 'G002', official_name_en: 'Demo Guardian Two' }]);
  assert.equal(r.c.data.summary.creates, 2, JSON.stringify(r.c.data));
  r = await importRows(a, 'student_guardians', [
    { admission_no: '000101', guardian_code: 'G001', relationship_code: 'parent', family_code: 'F001', portal_access: 'true', pickup_authorized: 'true' },
    { admission_no: '000102', guardian_code: 'G001', relationship_code: 'parent', family_code: 'F001', portal_access: 'true', pickup_authorized: 'true' },
    { admission_no: '000103', guardian_code: 'G002', relationship_code: 'parent', portal_access: 'true', pickup_authorized: 'true' },
  ]);
  assert.equal(r.c.data.summary.creates, 3, JSON.stringify(r.c.data));
  S.today = today;
});

test('import validation: invalid dates, formula injection, duplicates, unknown references, tenant column, blank-keeps and __CLEAR__', async () => {
  const a = S.adminA;
  const v = await a.post('/api/imports/validate', { module: 'students', mode: 'upsert', rows: [
    { admission_no: '000201', official_name_en: '=HYPERLINK("http://x")', date_of_birth: '2018-02-30' },
    { admission_no: '000202', official_name_en: 'Dup A', date_of_birth: '2018-01-01' },
    { admission_no: '000202', official_name_en: 'Dup B', date_of_birth: '2018-01-01' },
  ] });
  assert.equal(v.data.summary.invalid, 2);
  const e1 = v.data.errors.find((x) => x.row === 2).errors.map((x) => x.column);
  assert.ok(e1.includes('official_name_en') && e1.includes('date_of_birth'));
  assert.match(JSON.stringify(v.data.errors.find((x) => x.row === 4)), /duplicate of row 3/);
  const c = await a.post('/api/imports/commit', { module: 'students', mode: 'upsert', rows: [{ admission_no: '000201', official_name_en: '=1+1', date_of_birth: '2018-02-30' }] });
  assert.equal(c.status, 400);
  const ten = await a.post('/api/imports/validate', { module: 'students', mode: 'upsert', rows: [{ school_id: 'other', admission_no: '1', official_name_en: 'x', date_of_birth: '2018-01-01' }] });
  assert.ok(ten.data.summary.file_errors.length);
  const ref = await a.post('/api/imports/validate', { module: 'enrollments', mode: 'upsert', rows: [{ admission_no: '999999', academic_year_code: S.ay, campus_code: 'MAIN', class_code: 'Y1A', start_date: '2026-09-01' }] });
  assert.match(JSON.stringify(ref.data.errors), /not found/);
  // Blank cells keep existing values; __CLEAR__ requires confirmation.
  await importRows(a, 'students', [{ admission_no: '000103', official_name_en: 'Demo Learner Three', date_of_birth: '2018-05-01', preferred_name: 'Three' }]);
  let r = await importRows(a, 'students', [{ admission_no: '000103', official_name_en: 'Demo Learner Three', date_of_birth: '2018-05-01', preferred_name: '' , official_name_ar: 'ثلاثة' }]);
  assert.equal(r.c.data.summary.updates, 1);
  let s = (await a.get('/api/students?q=000103')).data.rows[0];
  assert.equal(s.preferred_name, 'Three');
  r = await importRows(a, 'students', [{ admission_no: '000103', official_name_en: 'Demo Learner Three', date_of_birth: '2018-05-01', preferred_name: '__CLEAR__' }]);
  assert.equal(r.c.status, 400);
  r = await importRows(a, 'students', [{ admission_no: '000103', official_name_en: 'Demo Learner Three', date_of_birth: '2018-05-01', preferred_name: '__CLEAR__' }], { confirm_clear: true });
  assert.equal(r.c.status, 200);
  s = (await a.get('/api/students?q=000103')).data.rows[0];
  assert.equal(s.preferred_name, null);
});

test('student edit persists after reload; admission number change keeps relationships; stale version is rejected', async () => {
  const a = S.adminA;
  const s = (await a.get('/api/students?q=000101')).data.rows[0];
  const d = (await a.get('/api/students/' + s.id)).data;
  const r = await a.put('/api/students/' + s.id, { ...d.student, admission_no: '000101A', preferred_name: 'One', version: d.student.version });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = (await a.get('/api/students/' + s.id)).data;
  assert.equal(after.student.admission_no, '000101A');
  assert.equal(after.enrollments.length, 1);
  assert.equal(after.guardians.length, 1);
  const stale = await a.put('/api/students/' + s.id, { ...d.student, preferred_name: 'Stale', version: d.student.version });
  assert.equal(stale.status, 409);
  S.s1 = s.id;
});

test('school B is fully isolated from school A', async () => {
  const b = new Client();
  const r = await b.post('/api/setup', { token: await setupToken(), school_code: 'DEMOB', name_en: 'Demo School B', admin_name: 'Admin B', admin_email: 'admin.b@example.invalid', password: PW, create_default_structure: false });
  assert.equal(r.status, 200);
  await b.refresh();
  await enrolMfa(b);
  assert.equal((await b.get('/api/students?status=all')).data.total, 0);
  assert.equal((await b.get('/api/students/' + S.s1)).status, 404);
  assert.equal((await b.put('/api/students/' + S.s1, { official_name_en: 'Hijack', date_of_birth: '2018-01-01', admission_no: 'X', version: 1 })).status, 404);
  const bc = await b.post('/api/campuses', { code: 'B1', name_en: 'B campus' });
  const ay = await b.post('/api/academic-years', { code: 'AYB', start_date: '2026-08-01', end_date: '2027-06-30' });
  // Referencing another school's class/year by guessed ID is rejected.
  const x = await b.post('/api/classes', { academic_year_id: S.classes.Y1A.academic_year_id, campus_id: bc.data.id, code: 'X1' });
  assert.equal(x.status, 400);
  const x2 = await b.post('/api/students/' + S.s1 + '/enrollments', { class_id: S.classes.Y1A.id, start_date: '2026-09-01' });
  assert.equal(x2.status, 404);
  assert.equal((await b.get('/api/attendance/register?class_id=' + S.classes.Y1A.id)).status, 404);
  const exp = await b.get('/api/students/export?status=all');
  assert.ok(!String(exp.data).includes('Demo Learner'));
  const imp = await b.post('/api/imports/validate', { module: 'enrollments', mode: 'upsert', rows: [{ admission_no: '000102', academic_year_code: S.ay, campus_code: 'MAIN', class_code: 'Y1A', start_date: '2026-09-01' }] });
  assert.equal(imp.data.summary.invalid, 1);
  assert.ok(ay.status === 201);
  S.adminB = b;
});

test('teacher sees only assigned class; permission removal applies on the next request', async () => {
  const a = S.adminA;
  const roles = (await a.get('/api/roles')).data.roles;
  const teacherRole = roles.find((r) => r.code === 'class_teacher');
  const staff = (await a.get('/api/staff?q=S0001')).data.rows[0];
  const inv = await a.post('/api/users/invite', { email: 'teacher.one@example.invalid', display_name: 'Demo Teacher One', role_ids: [teacherRole.id], staff_id: staff.id });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  const token = inv.data.invite_path.split('/').pop();
  const t = new Client();
  assert.equal((await t.post('/api/invite/accept', { token, password: PW })).status, 200);
  assert.equal((await t.post('/api/invite/accept', { token, password: PW })).data.error.code, 'TOKEN_USED');
  assert.equal((await t.post('/api/login', { email: 'teacher.one@example.invalid', password: PW })).status, 200);
  await t.refresh();
  const list = await t.get('/api/students');
  assert.deepEqual(list.data.rows.map((s) => s.class_code).sort(), ['Y1A', 'Y1A']);
  assert.equal((await t.get('/api/attendance/register?class_id=' + S.classes.Y6A.id)).status, 403);
  const reg = await t.get('/api/attendance/register?class_id=' + S.classes.Y1A.id + '&date=' + S.today);
  assert.equal(reg.status, 200);
  assert.equal(reg.data.rows.length, 2);
  assert.ok(reg.data.rows.every((r) => r.status_code === null));
  // Teacher cannot call admin endpoints.
  assert.equal((await t.get('/api/users')).status, 403);
  assert.equal((await t.post('/api/imports/validate', { module: 'students', rows: [] })).status, 403);
  S.teacher = t; S.teacherRole = teacherRole;
});

test('attendance save updates summary; unmarked is never counted present', async () => {
  const t = S.teacher;
  const reg = (await t.get('/api/attendance/register?class_id=' + S.classes.Y1A.id + '&date=' + S.today)).data;
  const r = await t.post('/api/attendance/register', { class_id: S.classes.Y1A.id, date: S.today, marks: [{ student_id: reg.rows[0].student_id, status_code: 'present' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sum = (await S.adminA.get('/api/attendance/summary?date=' + S.today)).data;
  const y1 = sum.classes.find((c) => c.code === 'Y1A');
  assert.equal(y1.enrolled, 2); assert.equal(y1.present, 1); assert.equal(y1.unmarked, 1);
  assert.equal(sum.totals.attendance_rate, 100);
  const future = await t.post('/api/attendance/register', { class_id: S.classes.Y1A.id, date: '2099-01-01', marks: [{ student_id: reg.rows[0].student_id, status_code: 'present' }] });
  assert.equal(future.status, 400);
  const csv = await S.adminA.get(`/api/attendance/export?from=${S.today}&to=${S.today}`);
  assert.match(csv.data, /present/);
});

test('permission revoked → next API call denied; restored → allowed', async () => {
  const a = S.adminA;
  const perms = S.teacherRole.permissions.filter((p) => p !== 'attendance.view');
  assert.equal((await a.put(`/api/roles/${S.teacherRole.id}/permissions`, { permissions: perms })).status, 200);
  assert.equal((await S.teacher.get('/api/attendance/summary')).status, 403);
  assert.ok(!(await S.teacher.refresh()).permissions.includes('attendance.view'));
  await a.put(`/api/roles/${S.teacherRole.id}/permissions`, { permissions: S.teacherRole.permissions });
  assert.equal((await S.teacher.get('/api/attendance/summary')).status, 200);
});

test('family QR check-in calls siblings in Y1A and Y6A; concurrency-safe; dismissed child excluded; revoked card fails', async () => {
  const a = S.adminA;
  const fam = (await a.get('/api/families?q=F001')).data.rows[0];
  const issue = await a.post('/api/families/credentials/issue', { family_ids: [fam.id] });
  assert.equal(issue.status, 200, JSON.stringify(issue.data));
  const card = issue.data.cards[0];
  assert.match(card.reference, /^FC-\d{5}$/);
  assert.ok(!card.token.includes('Learner'));
  const look = await a.post('/api/dismissal/family-lookup', { token: card.token });
  assert.equal(look.data.children.length, 2);
  assert.ok(look.data.authorized_collectors.length >= 1);
  // Two simultaneous scans → one record per child.
  const [r1, r2] = await Promise.all([a.post('/api/dismissal/checkin', { token: card.token, idempotency_key: 'k1' }), a.post('/api/dismissal/checkin', { token: card.token, idempotency_key: 'k2' })]);
  assert.equal(r1.status, 200, JSON.stringify(r1.data)); assert.equal(r2.status, 200);
  const n = env.DB.raw.prepare('SELECT COUNT(*) c FROM dismissal_records').get().c;
  assert.equal(n, 2);
  // Teacher of Y1A sees only their student as called.
  const board = (await S.teacher.get('/api/dismissal/board')).data;
  const called = board.rows.filter((r) => r.status === 'called');
  assert.equal(called.length, 1);
  assert.equal(board.rows.length, 2); // includes the not-called classmate
  assert.equal((await S.teacher.post(`/api/dismissal/${called[0].record_id}/dismiss`)).status, 200);
  // Y6A record is outside the Y1A teacher's scope.
  const y6rec = env.DB.raw.prepare("SELECT d.id FROM dismissal_records d JOIN classes c ON c.id = d.class_id WHERE c.code = 'Y6A'").get().id;
  assert.equal((await S.teacher.post(`/api/dismissal/${y6rec}/dismiss`)).status, 403);
  // Scan again: dismissed child excluded, other child stays called (no duplicates).
  const again = await a.post('/api/dismissal/checkin', { token: card.token });
  assert.deepEqual(again.data.excluded.map((x) => x.reason).sort(), ['already_called', 'already_dismissed']);
  assert.equal(again.data.newly_called, 0);
  // Idempotent replay.
  assert.equal((await a.post('/api/dismissal/checkin', { token: card.token, idempotency_key: 'k1' })).data.replayed, true);
  // Reopen requires a reason.
  assert.equal((await a.post(`/api/dismissal/${called[0].record_id}/reopen`, {})).status, 400);
  assert.equal((await a.post(`/api/dismissal/${called[0].record_id}/reopen`, { reason: 'Released in error' })).status, 200);
  // Revoke card → scan fails safely.
  const cred = (await a.get(`/api/families/${fam.id}/credentials`)).data.rows[0];
  assert.equal((await a.post(`/api/family-credentials/${cred.id}/revoke`, { reason: 'Card lost' })).status, 200);
  const revoked = await a.post('/api/dismissal/checkin', { token: card.token });
  assert.equal(revoked.data.error.code, 'QR_REVOKED');
  // Another school cannot use this school's card.
  assert.equal((await S.adminB.post('/api/dismissal/checkin', { token: card.token })).status, 404);
});

test('parent portal shows only explicitly linked children', async () => {
  const a = S.adminA;
  const g = (await a.get('/api/guardians?q=G001')).data.rows[0];
  const parentRole = (await a.get('/api/roles')).data.roles.find((r) => r.code === 'parent');
  const inv = await a.post('/api/users/invite', { email: 'guardian.one@example.invalid', display_name: 'Demo Guardian One', role_ids: [parentRole.id], guardian_id: g.id });
  const p = new Client();
  await p.post('/api/invite/accept', { token: inv.data.invite_path.split('/').pop(), password: PW });
  await p.post('/api/login', { email: 'guardian.one@example.invalid', password: PW });
  await p.refresh();
  const kids = (await p.get('/api/portal/children')).data.children;
  assert.deepEqual(kids.map((k) => k.official_name_en).sort(), ['Demo Learner One', 'Demo Learner Two']);
  assert.equal((await p.get('/api/students')).status, 403);
  assert.equal((await p.get('/api/students/' + S.s1)).status, 403);
});

test('privilege escalation blocked; disabling a user revokes sessions', async () => {
  const a = S.adminA;
  const roles = (await a.get('/api/roles')).data.roles;
  const itRole = roles.find((r) => r.code === 'it_admin');
  const inv = await a.post('/api/users/invite', { email: 'it@example.invalid', display_name: 'IT', role_ids: [itRole.id] });
  const it = new Client();
  await it.post('/api/invite/accept', { token: inv.data.invite_path.split('/').pop(), password: PW });
  await it.post('/api/login', { email: 'it@example.invalid', password: PW });
  await it.refresh();
  await enrolMfa(it);
  const superRole = roles.find((r) => r.code === 'school_super_admin');
  const esc = await it.put(`/api/users/${inv.data.id}/roles`, { role_ids: [superRole.id] });
  assert.equal(esc.status, 403);
  const tid = (await a.get('/api/users?q=teacher.one')).data.rows[0].id;
  await a.post(`/api/users/${tid}/status`, { status: 'disabled', reason: 'test' });
  assert.equal((await S.teacher.get('/api/me')).status, 401);
});

test('audit log is signed and append-only', async () => {
  const r = await S.adminA.get('/api/audit?size=200');
  assert.ok(r.data.total > 10);
  assert.ok(r.data.rows.every((x) => x.verified));
  assert.throws(() => env.DB.raw.exec("UPDATE audit_log SET action = 'x'"), /append-only/);
  assert.throws(() => env.DB.raw.exec('DELETE FROM audit_log'), /append-only/);
  const b = await S.adminB.get('/api/audit?size=200');
  assert.ok(b.data.rows.every((x) => x.tenant_id === b.data.rows[0].tenant_id));
  assert.ok(!JSON.stringify(b.data).includes('Demo School A'));
});

test('login lockout after repeated failures', async () => {
  const c = new Client();
  for (let i = 0; i < 5; i++) await c.post('/api/login', { email: 'admin.b@example.invalid', password: 'wrong-password-123' });
  const r = await c.post('/api/login', { email: 'admin.b@example.invalid', password: PW });
  assert.equal(r.status, 423);
});
