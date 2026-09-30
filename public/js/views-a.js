import { t, nm, getLang, setLang } from '../i18n.js';
import { h, api, state, icon, can, errText, toast, badge, statusBadge, fmtDate, dataTable, modal, form, formModal, tabs, loadScript, debounce, todayLocal } from './core.js';

const pageHead = (title, ...actions) => h('div', { class: 'page-head' }, h('h1', {}, title), ...actions);
const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '')).toString();
export async function options(endpoint, label = (r) => `${r.code} — ${nm(r.name_en, r.name_ar)}`) {
  const d = await api(`${endpoint}?size=200`);
  return d.rows.map((r) => [r.id, label(r)]);
}

// ---------------- Auth pages ----------------
function authCard(title, subtitle, body) {
  return h('div', { class: 'auth' }, h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h1', { class: 'spacer' }, title), h('button', { class: 'btn sm', onclick: () => { setLang(getLang() === 'ar' ? 'en' : 'ar'); window.dispatchEvent(new HashChangeEvent('hashchange')); } }, getLang() === 'ar' ? 'English' : 'العربية')),
    subtitle ? h('p', { class: 'muted', style: { margin: 0 } }, subtitle) : null, body,
    h('div', { class: 'foot' }, t('Developed by Noviqtek'))));
}
export async function loginView(root) {
  let mfaStep = false;
  const f = form([
    { name: 'email', label: t('Email'), type: 'email', required: true, autocomplete: 'username' },
    { name: 'password', label: t('Password'), type: 'password', required: true, autocomplete: 'current-password' },
  ], {}, {
    submitLabel: t('Sign in'),
    onSubmit: async (v) => {
      const body = { email: v.email, password: v.password };
      if (mfaStep) body.mfa_code = codeInput.value.trim();
      const r = await api('/api/login', { method: 'POST', body });
      if (r.mfa_required) { mfaStep = true; codeWrap.hidden = false; codeInput.focus(); return; }
      state.me = null; location.hash = '#/';
    },
  });
  const codeInput = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]{6}' });
  const codeWrap = h('label', { class: 'field', hidden: true }, t('Authentication code'), codeInput, h('span', { class: 'hint' }, 'Enter the 6-digit code from your authenticator app.'));
  f.el.querySelector('.grid-form').append(codeWrap);
  f.el.querySelector('.grid-form').style.gridTemplateColumns = '1fr';
  const firstRun = h('div');
  root.append(authCard('Noviqtek School Management', t('Sign in'), h('div', {}, firstRun, f.el)));
  api('/api/health').then((hl) => { if (hl.setup_key_available) firstRun.replaceChildren(h('div', { class: 'alert info' }, 'New installation: ', h('a', { href: '#/setup' }, 'set up your school'), ' with the setup key you chose on Cloudflare.')); }).catch(() => {});
}
const PW_HINT = 'At least 12 characters using three of: lowercase, uppercase, digits, symbols.';
export async function setupView(root, m) {
  const token = m ? decodeURIComponent(m[1]) : null;
  if (token) {
    try { await api('/api/setup/check', { method: 'POST', body: { token } }); }
    catch (e) { root.append(authCard(t('School setup required.'), null, h('div', { class: 'alert error' }, errText(e)))); return; }
  } else {
    const hl = await api('/api/health').catch(() => ({}));
    if (!hl.setup_key_available) { root.append(authCard(t('School setup required.'), null, h('div', { class: 'alert error' }, hl.schools_configured ? 'A school already exists. Sign in, or ask Noviqtek for a one-time setup link to add another school.' : 'No SETUP_KEY secret is configured for this installation. Add it in Cloudflare (Worker → Settings → Variables and Secrets) or run the CLI deploy to get a setup link.'), h('p', {}, h('a', { href: '#/login' }, t('Sign in'))))); return; }
  }
  const f = form([
    ...(token ? [] : [{ name: 'setup_key', label: 'Setup key', type: 'password', required: true, wide: true, hint: 'The SETUP_KEY value you entered when installing on Cloudflare.' }]),
    { name: 'school_code', label: 'School code', required: true, hint: 'Short unique code, e.g. ABC-DOHA', max: 20 },
    { name: 'name_en', label: 'School name (English)', required: true }, { name: 'name_ar', label: 'School name (Arabic)', dir: 'rtl' },
    { name: 'admin_name', label: 'Your name', required: true }, { name: 'admin_email', label: t('Email'), type: 'email', required: true, autocomplete: 'username' },
    { name: 'password', label: t('Password'), type: 'password', required: true, hint: PW_HINT, autocomplete: 'new-password' },
    { name: 'create_default_structure', label: 'Create sample structure (Year 1A–6B, two timing groups)', type: 'checkbox', wide: true },
  ], { create_default_structure: true }, {
    submitLabel: 'Create school',
    onSubmit: async (v) => { await api('/api/setup', { method: 'POST', body: { ...v, ...(token ? { token } : {}) } }); state.me = null; location.hash = '#/mfa'; },
  });
  root.append(authCard('Set up your school', 'This one-time link creates the first school administrator. Two-factor authentication is set up next.', f.el));
}
export async function inviteView(root, m, purpose) {
  const token = decodeURIComponent(m[1]);
  let info;
  try { info = await api('/api/invite/check', { method: 'POST', body: { token, purpose } }); }
  catch (e) { root.append(authCard(purpose === 'invite' ? 'Accept invitation' : 'Reset password', null, h('div', { class: 'alert error' }, errText(e)))); return; }
  const f = form([
    { name: 'password', label: 'New password', type: 'password', required: true, hint: PW_HINT, autocomplete: 'new-password' },
    { name: 'confirm', label: 'Confirm password', type: 'password', required: true, autocomplete: 'new-password' },
  ], {}, {
    submitLabel: 'Set password',
    onSubmit: async (v) => {
      if (v.password !== v.confirm) throw new Error('Passwords do not match.');
      await api('/api/invite/accept', { method: 'POST', body: { token, purpose, password: v.password } });
      toast('Password set. Please sign in.'); location.hash = '#/login';
    },
  });
  f.el.querySelector('.grid-form').style.gridTemplateColumns = '1fr';
  root.append(authCard(purpose === 'invite' ? `${t('Welcome')}, ${info.display_name}` : 'Reset password', info.email, f.el));
}

// ---------------- Dashboard ----------------
export async function dashboardView(root) {
  const d = await api('/api/dashboard');
  const kpis = h('div', { class: 'kpis' }, d.metrics.map((m) => h('a', { class: 'card kpi ' + (m.tone || ''), href: m.link, title: m.definition },
    h('div', { class: 'label' }, getLang() === 'ar' ? m.label_ar : m.label_en), h('div', { class: 'value' }, String(m.value)), m.sub ? h('div', { class: 'sub' }, m.sub) : null,
    h('span', { class: 'sr-only' }, m.definition))));
  const defs = h('details', { class: 'card card-pad', style: { marginBottom: '16px' } }, h('summary', {}, 'Metric definitions'),
    h('ul', {}, d.metrics.map((m) => h('li', {}, h('b', {}, m.label_en + ': '), m.definition))), h('p', { class: 'muted' }, `Scope: ${d.scope}. ${t('Last updated')}: ${fmtDate(d.generated_at)}.`));
  root.replaceChildren(pageHead(`${t('Welcome')}, ${state.me.user.display_name}`, h('span', { class: 'muted' }, fmtDate(d.date))), kpis, defs);
  if (d.setup) {
    root.append(h('div', { class: 'card card-pad' }, h('h2', {}, t('Setup checklist')),
      h('ul', { class: 'checklist' }, d.setup.map((s) => h('li', {}, s.done ? badge('Done', 'ok') : badge('To do', 'warn'), getLang() === 'ar' ? s.ar : s.en)))));
  }
}

// ---------------- Students ----------------
export async function studentsView(root) {
  const classes = await options('/api/classes', (r) => r.code).catch(() => []);
  const f = { q: '', class_id: '', status: 'active' };
  const table = dataTable({
    id: 'students',
    columns: [
      { key: 'admission_no', label: t('Admission no.'), sortKey: 'admission_no', render: (r) => h('span', { class: 'mono' }, r.admission_no) },
      { key: 'official_name_en', label: t('Name (English)'), sortKey: 'name', render: (r) => h('a', { href: `#/students/${r.id}` }, r.official_name_en) },
      { key: 'official_name_ar', label: t('Name (Arabic)'), render: (r) => h('span', { dir: 'rtl' }, r.official_name_ar || '') },
      { key: 'class_code', label: t('Class'), sortKey: 'class' },
      { key: 'date_of_birth', label: t('Date of birth'), sortKey: 'dob', render: (r) => fmtDate(r.date_of_birth), hidden: true },
      { key: 'gender_code', label: t('Gender'), hidden: true },
      { key: 'status', label: t('Status'), render: (r) => statusBadge(r.status) },
    ],
    rowActions: (r) => h('a', { class: 'btn sm', href: `#/students/${r.id}` }, can('student.edit') ? t('Edit') : t('Details')),
    fetchPage: ({ page, size, sort, dir }) => api('/api/students?' + q({ ...f, page, size, sort, dir })),
  });
  const reload = debounce(() => table.reload(true));
  const toolbar = h('div', { class: 'toolbar' },
    h('input', { type: 'search', placeholder: `${t('Search')}: ${t('Admission no.')}, ${t('Name (English)')}…`, 'aria-label': t('Search'), oninput: (e) => { f.q = e.target.value; reload(); } }),
    h('select', { 'aria-label': t('Class'), onchange: (e) => { f.class_id = e.target.value; table.reload(true); } }, h('option', { value: '' }, `${t('Class')}: ${t('All')}`), classes.map(([id, l]) => h('option', { value: id }, l))),
    h('select', { 'aria-label': t('Status'), onchange: (e) => { f.status = e.target.value; table.reload(true); } }, ['active', 'withdrawn', 'graduated', 'archived', 'all'].map((s) => h('option', { value: s }, t(s === 'all' ? 'All' : s)))),
    h('span', { class: 'spacer' }),
    can('student.export') ? h('a', { class: 'btn', href: '#', onclick: (e) => { e.preventDefault(); location.href = '/api/students/export?' + q(f); } }, t('Export CSV')) : null);
  root.replaceChildren(pageHead(t('Students'), can('student.create') ? h('a', { class: 'btn primary', href: '#/students/new' }, `+ ${t('New')}`) : null), toolbar, table.el);
  table.reload();
}

const studentFields = () => [
  { name: 'admission_no', label: t('Admission no.'), required: true, hint: 'Editable; the internal record ID never changes.' },
  { name: 'official_name_en', label: t('Name (English)'), required: true }, { name: 'official_name_ar', label: t('Name (Arabic)'), dir: 'rtl' },
  { name: 'preferred_name', label: t('Preferred name') }, { name: 'date_of_birth', label: t('Date of birth'), type: 'date', required: true },
  { name: 'gender_code', label: t('Gender'), type: 'select', options: [['M', 'M'], ['F', 'F']] }, { name: 'nationality_code', label: t('Nationality'), hint: 'ISO code, e.g. QA', max: 3 },
  { name: 'school_email', label: t('School email'), type: 'email' }, { name: 'joined_date', label: t('Joined'), type: 'date' },
  { name: 'status', label: t('Status'), type: 'select', required: true, options: ['active', 'withdrawn', 'graduated', 'archived'].map((s) => [s, t(s)]) },
];
export async function studentEditView(root, m) {
  const id = m[1];
  if (id === undefined || location.hash === '#/students/new') {
    const f = form(studentFields(), { status: 'active' }, { onSubmit: async (v) => { const r = await api('/api/students', { method: 'POST', body: v }); toast('Student created.'); location.hash = `#/students/${r.id}`; } });
    root.replaceChildren(pageHead(`${t('New')} — ${t('Students')}`, h('a', { class: 'btn', href: '#/students' }, t('Cancel'))), h('div', { class: 'card card-pad' }, f.el));
    return;
  }
  const d = await api(`/api/students/${id}`);
  let version = d.student.version;
  const editable = can('student.edit');
  const f = form(studentFields(), d.student, {
    onSubmit: async (v) => {
      const r = await api(`/api/students/${id}`, { method: 'PUT', body: { ...v, version } });
      version = r.version; toast(r.unchanged ? 'No changes to save.' : 'Saved.');
    },
  });
  if (!editable) f.el.querySelectorAll('input,select,button').forEach((x) => { x.disabled = true; });
  const enr = h('div', { class: 'card card-pad' }, h('div', { class: 'row' }, h('h2', { class: 'spacer' }, t('Enrollments')),
    editable ? h('button', { class: 'btn sm', onclick: async () => {
      const cls = await options('/api/classes', (r) => `${r.code} (${r.academic_year_code}) — ${r.enrolled}/${r.capacity ?? '∞'}`);
      formModal('Enroll / move class', [{ name: 'class_id', label: t('Class'), type: 'select', required: true, options: cls }, { name: 'start_date', label: t('Start date'), type: 'date', required: true }, { name: 'override_capacity', label: 'Allow over capacity', type: 'checkbox' }],
        { start_date: todayLocal() }, async (v) => { await api(`/api/students/${id}/enrollments`, { method: 'POST', body: v }); toast('Enrollment saved.'); studentEditView(root, m); });
    } }, `+ ${t('Add')}`) : null),
  d.enrollments.length ? h('table', { class: 'data' }, h('thead', {}, h('tr', {}, [t('Class'), 'Year', t('Campus'), t('Start date'), t('End date'), t('Status')].map((x) => h('th', {}, x)))),
    h('tbody', {}, d.enrollments.map((e) => h('tr', {}, h('td', {}, e.class_code), h('td', {}, e.academic_year_code), h('td', {}, e.campus_code), h('td', {}, fmtDate(e.start_date)), h('td', {}, fmtDate(e.end_date)), h('td', {}, statusBadge(e.enrollment_status))))))
    : h('p', { class: 'muted' }, 'Not enrolled in any class.'));
  let guard = null;
  if (d.guardians) {
    guard = h('div', { class: 'card card-pad' }, h('div', { class: 'row' }, h('h2', { class: 'spacer' }, t('Guardian links')),
      can('family.manage') ? h('button', { class: 'btn sm', onclick: async () => {
        const gs = await options('/api/guardians', (r) => `${r.guardian_code} — ${r.official_name_en}`);
        const fs = await options('/api/families', (r) => `${r.family_code} — ${r.family_label || ''}`);
        formModal('Link guardian', [
          { name: 'guardian_id', label: 'Guardian', type: 'select', required: true, options: gs }, { name: 'family_id', label: t('Family'), type: 'select', options: fs },
          { name: 'relationship_code', label: t('Relationship'), type: 'select', required: true, options: ['mother', 'father', 'parent', 'legal_guardian', 'grandparent', 'sibling', 'other'].map((x) => [x, x]) },
          { name: 'emergency_priority', label: 'Emergency priority', type: 'number' }, { name: 'pickup_authorized', label: 'Authorised for pickup', type: 'checkbox' },
          { name: 'portal_access', label: 'Parent portal access', type: 'checkbox' }, { name: 'billing_contact', label: 'Billing contact', type: 'checkbox' },
          { name: 'valid_from', label: 'Valid from', type: 'date' }, { name: 'valid_to', label: 'Valid to', type: 'date' },
        ], {}, async (v) => { await api(`/api/students/${id}/guardians`, { method: 'POST', body: v }); toast('Guardian linked.'); studentEditView(root, m); });
      } }, `+ ${t('Add')}`) : null),
    h('p', { class: 'hint' }, 'Access comes only from these explicit links — never from a shared surname, email or address.'),
    d.guardians.length ? h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ['Guardian', t('Relationship'), t('Family'), t('Phone'), t('Pickup'), t('Portal'), 'Valid', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, d.guardians.map((g) => h('tr', {}, h('td', {}, nm(g.official_name_en, g.official_name_ar)), h('td', {}, g.relationship_code), h('td', {}, g.family_code || ''), h('td', { dir: 'ltr' }, g.phone || ''),
        h('td', {}, g.pickup_authorized ? badge('Yes', 'ok') : badge('No', 'muted')), h('td', {}, g.portal_access ? badge('Yes', 'ok') : badge('No', 'muted')),
        h('td', {}, `${g.valid_from ? fmtDate(g.valid_from) : '…'} – ${g.valid_to ? fmtDate(g.valid_to) : '…'}`),
        h('td', {}, can('family.manage') && !(g.valid_to && g.valid_to < todayLocal()) ? h('button', { class: 'btn sm danger', onclick: async () => {
          const reason = prompt('Reason for ending this link:'); if (!reason) return;
          await api(`/api/student-guardians/${g.id}/end`, { method: 'POST', body: { reason } }); studentEditView(root, m);
        } }, 'End link') : null)))))
      : h('p', { class: 'muted' }, 'No guardians linked.'));
  }
  root.replaceChildren(pageHead(nm(d.student.official_name_en, d.student.official_name_ar), statusBadge(d.student.status), h('a', { class: 'btn', href: '#/students' }, t('Close'))),
    h('div', { class: 'card card-pad', style: { marginBottom: '16px' } }, h('h2', {}, t('Details')), f.el),
    h('div', { style: { display: 'grid', gap: '16px' } }, enr, guard));
}

// ---------------- Generic master-data page ----------------
function entityPanel({ id, endpoint, columns, fields, manage, title, extraActions, filters = {} }) {
  const wrap = h('div');
  const table = dataTable({
    id, columns: [...columns, { key: 'status', label: t('Status'), render: (r) => r.status ? statusBadge(r.status) : '' }],
    fetchPage: ({ page, size }) => api(`${endpoint}?` + q({ page, size, q: wrap.dataset.q, status: wrap.dataset.status, ...filters })),
    rowActions: (r) => [can(manage) ? h('button', { class: 'btn sm', onclick: async () => {
      formModal(`${t('Edit')} — ${title}`, await fields(), r, async (v) => { const res = await api(`${endpoint}/${r.id}`, { method: 'PUT', body: { ...v, version: r.version } }); toast(res.unchanged ? 'No changes.' : 'Saved.'); table.reload(); });
    } }, t('Edit')) : null, can(manage) && r.status ? h('button', { class: 'btn sm', onclick: async () => {
      const restore = r.status === 'archived'; const reason = restore ? '' : prompt('Reason for archiving (optional):');
      if (reason === null) return;
      await api(`${endpoint}/${r.id}/archive`, { method: 'POST', body: { restore, reason } }); toast(restore ? 'Restored.' : 'Archived.'); table.reload();
    } }, r.status === 'archived' ? t('Restore') : t('Archive')) : null, extraActions ? extraActions(r, table) : null],
  });
  wrap.append(h('div', { class: 'toolbar' },
    h('input', { type: 'search', placeholder: t('Search'), 'aria-label': t('Search'), oninput: debounce((e) => { wrap.dataset.q = e.target.value; table.reload(true); }) }),
    h('select', { 'aria-label': t('Status'), onchange: (e) => { wrap.dataset.status = e.target.value; table.reload(true); } }, h('option', { value: '' }, t('active')), h('option', { value: 'archived' }, t('archived')), h('option', { value: 'all' }, t('All'))),
    h('span', { class: 'spacer' }),
    can(manage) ? h('button', { class: 'btn primary', onclick: async () => formModal(`${t('New')} — ${title}`, await fields(), {}, async (v) => { await api(endpoint, { method: 'POST', body: v }); toast('Created.'); table.reload(); }) }, `+ ${t('New')}`) : null), table.el);
  table.reload();
  return wrap;
}

export async function classesView(root) {
  const fields = async () => [
    { name: 'academic_year_id', label: 'Academic year', type: 'select', required: true, options: await options('/api/academic-years', (r) => r.code + (r.is_current ? ' (current)' : '')) },
    { name: 'campus_id', label: t('Campus'), type: 'select', required: true, options: await options('/api/campuses') },
    { name: 'year_group_id', label: t('Year group'), type: 'select', options: await options('/api/year-groups') },
    { name: 'code', label: t('Code'), required: true }, { name: 'name_en', label: t('Name (English)') }, { name: 'name_ar', label: t('Name (Arabic)'), dir: 'rtl' },
    { name: 'room_code', label: t('Room') }, { name: 'capacity', label: t('Capacity'), type: 'number' },
    { name: 'class_teacher_staff_id', label: 'Class teacher', type: 'select', options: await options('/api/staff', (r) => `${r.staff_code} — ${r.official_name_en}`) },
  ];
  root.replaceChildren(pageHead(t('Classes')), entityPanel({
    id: 'classes', endpoint: '/api/classes', manage: 'academic.manage', title: t('Classes'), fields,
    columns: [
      { key: 'code', label: t('Code'), render: (r) => h('b', {}, r.code) }, { key: 'name', label: t('Name (English)'), render: (r) => nm(r.name_en, r.name_ar) },
      { key: 'year_group_code', label: t('Year group') }, { key: 'timing_group_code', label: t('Timing group') },
      { key: 'enrolled', label: `${t('Enrolled')} / ${t('Capacity')}`, num: true, render: (r) => h('span', {}, `${r.enrolled} / ${r.capacity ?? '—'}`, r.capacity && r.enrolled >= r.capacity ? badge('Full', 'warn') : '') },
      { key: 'class_teacher_name', label: t('Teacher') }, { key: 'room_code', label: t('Room') }, { key: 'campus_code', label: t('Campus'), hidden: true }, { key: 'academic_year_code', label: 'Year', hidden: true },
    ],
    extraActions: (r) => h('a', { class: 'btn sm', href: '#/attendance?class=' + r.id }, t('Register')),
  }));
}

export async function academicsView(root) {
  const panels = {
    years: () => entityPanel({ id: 'ay', endpoint: '/api/academic-years', manage: 'academic.manage', title: t('Academic years'),
      columns: [{ key: 'code', label: t('Code') }, { key: 'label', label: 'Label' }, { key: 'start_date', label: t('Start date'), render: (r) => fmtDate(r.start_date) }, { key: 'end_date', label: t('End date'), render: (r) => fmtDate(r.end_date) }, { key: 'is_current', label: t('Current'), render: (r) => r.is_current ? badge(t('Current'), 'info') : '' }],
      fields: async () => [{ name: 'code', label: t('Code'), required: true }, { name: 'label', label: 'Label', hint: 'Remove "(confirm dates)" once dates are confirmed.' }, { name: 'start_date', label: t('Start date'), type: 'date', required: true }, { name: 'end_date', label: t('End date'), type: 'date', required: true }, { name: 'is_current', label: t('Current'), type: 'checkbox' }] }),
    terms: () => entityPanel({ id: 'terms', endpoint: '/api/terms', manage: 'academic.manage', title: t('Terms'),
      columns: [{ key: 'academic_year_code', label: 'Year' }, { key: 'code', label: t('Code') }, { key: 'name', label: 'Name', render: (r) => nm(r.name_en, r.name_ar) }, { key: 'start_date', label: t('Start date'), render: (r) => fmtDate(r.start_date) }, { key: 'end_date', label: t('End date'), render: (r) => fmtDate(r.end_date) }],
      fields: async () => [{ name: 'academic_year_id', label: 'Academic year', type: 'select', required: true, options: await options('/api/academic-years', (r) => r.code) }, { name: 'code', label: t('Code'), required: true }, { name: 'name_en', label: t('Name (English)') }, { name: 'name_ar', label: t('Name (Arabic)'), dir: 'rtl' }, { name: 'start_date', label: t('Start date'), type: 'date', required: true }, { name: 'end_date', label: t('End date'), type: 'date', required: true }] }),
    yg: () => entityPanel({ id: 'yg', endpoint: '/api/year-groups', manage: 'academic.manage', title: t('Year groups'),
      columns: [{ key: 'code', label: t('Code') }, { key: 'name', label: 'Name', render: (r) => nm(r.name_en, r.name_ar) }, { key: 'timing_group_code', label: t('Timing group') }, { key: 'sort_order', label: 'Order', num: true }],
      fields: async () => [{ name: 'code', label: t('Code'), required: true }, { name: 'name_en', label: t('Name (English)'), required: true }, { name: 'name_ar', label: t('Name (Arabic)'), dir: 'rtl' }, { name: 'sort_order', label: 'Order', type: 'number' }, { name: 'timing_group_id', label: t('Timing group'), type: 'select', options: await options('/api/timing-groups') }] }),
    tg: () => entityPanel({ id: 'tg', endpoint: '/api/timing-groups', manage: 'academic.manage', title: t('Timing groups'),
      columns: [{ key: 'code', label: t('Code') }, { key: 'name', label: 'Name', render: (r) => nm(r.name_en, r.name_ar) }, { key: 'day_start', label: 'Start' }, { key: 'day_end', label: 'End' }],
      fields: async () => [{ name: 'code', label: t('Code'), required: true }, { name: 'name_en', label: t('Name (English)'), required: true }, { name: 'name_ar', label: t('Name (Arabic)'), dir: 'rtl' }, { name: 'day_start', label: 'Day start', type: 'time' }, { name: 'day_end', label: 'Day end', type: 'time' }] }),
    subjects: () => entityPanel({ id: 'subjects', endpoint: '/api/subjects', manage: 'academic.manage', title: t('Subjects'),
      columns: [{ key: 'code', label: t('Code') }, { key: 'name', label: 'Name', render: (r) => nm(r.name_en, r.name_ar) }, { key: 'department_code', label: t('Department') }, { key: 'policy_reference', label: 'Policy ref.' }],
      fields: async () => [{ name: 'code', label: t('Code'), required: true }, { name: 'name_en', label: t('Name (English)'), required: true }, { name: 'name_ar', label: t('Name (Arabic)'), dir: 'rtl' }, { name: 'department_id', label: t('Department'), type: 'select', options: await options('/api/departments') }, { name: 'policy_reference', label: 'Policy reference', hint: 'e.g. MOEHE policy version reviewed by the school' }] }),
    campuses: () => entityPanel({ id: 'campuses', endpoint: '/api/campuses', manage: 'tenant.configure', title: t('Campuses'),
      columns: [{ key: 'code', label: t('Code') }, { key: 'name', label: 'Name', render: (r) => nm(r.name_en, r.name_ar) }, { key: 'phone', label: t('Phone') }, { key: 'email', label: t('Email') }],
      fields: async () => [{ name: 'code', label: t('Code'), required: true }, { name: 'name_en', label: t('Name (English)'), required: true }, { name: 'name_ar', label: t('Name (Arabic)'), dir: 'rtl' }, { name: 'address', label: 'Address', wide: true }, { name: 'phone', label: t('Phone') }, { name: 'email', label: t('Email'), type: 'email' }] }),
  };
  const body = h('div');
  const show = (k) => body.replaceChildren(panels[k]());
  root.replaceChildren(pageHead(t('Academic setup')), tabs([['years', t('Academic years')], ['terms', t('Terms')], ['yg', t('Year groups')], ['tg', t('Timing groups')], ['subjects', t('Subjects')], ['campuses', t('Campuses')]], show, 'years'), body);
  show('years');
}

export async function staffView(root) {
  const panels = {
    staff: () => entityPanel({ id: 'staff', endpoint: '/api/staff', manage: 'staff.manage', title: t('Staff'),
      columns: [{ key: 'staff_code', label: t('Code'), render: (r) => h('span', { class: 'mono' }, r.staff_code) }, { key: 'name', label: 'Name', render: (r) => nm(r.official_name_en, r.official_name_ar) }, { key: 'job_title', label: t('Job title') }, { key: 'department_code', label: t('Department') }, { key: 'work_email', label: t('Email') }, { key: 'user_email', label: 'User account', render: (r) => r.user_email ? badge('Linked', 'ok') : badge('None', 'muted') }],
      fields: async () => [{ name: 'staff_code', label: t('Code'), required: true }, { name: 'official_name_en', label: t('Name (English)'), required: true }, { name: 'official_name_ar', label: t('Name (Arabic)'), dir: 'rtl' }, { name: 'work_email', label: t('Email'), type: 'email' }, { name: 'job_title', label: t('Job title') }, { name: 'department_id', label: t('Department'), type: 'select', options: await options('/api/departments') }, { name: 'campus_id', label: t('Campus'), type: 'select', options: await options('/api/campuses') }, { name: 'employment_start', label: 'Employment start', type: 'date' }, { name: 'employment_end', label: 'Employment end', type: 'date' }] }),
    ta: () => {
      const wrap = h('div');
      const table = dataTable({ id: 'ta', columns: [{ key: 'staff_name', label: t('Staff') }, { key: 'class_code', label: t('Class') }, { key: 'subject_code', label: 'Subject' }, { key: 'academic_year_code', label: 'Year' }, { key: 'weekly_load', label: 'Periods/week', num: true }],
        fetchPage: ({ page, size }) => api('/api/teaching-assignments?' + q({ page, size })),
        rowActions: (r) => can('staff.manage') ? h('button', { class: 'btn sm danger', onclick: async () => { if (!confirm('Remove this teaching assignment?')) return; await api(`/api/teaching-assignments/${r.id}`, { method: 'DELETE' }); table.reload(); } }, 'Remove') : null });
      wrap.append(h('div', { class: 'toolbar' }, h('span', { class: 'hint' }, 'Teaching assignments give subject teachers access to a class. Class teachers are set on the class.'), h('span', { class: 'spacer' }),
        can('staff.manage') ? h('button', { class: 'btn primary', onclick: async () => formModal(t('Teaching assignments'), [
          { name: 'staff_id', label: t('Staff'), type: 'select', required: true, options: await options('/api/staff', (r) => `${r.staff_code} — ${r.official_name_en}`) },
          { name: 'academic_year_id', label: 'Academic year', type: 'select', required: true, options: await options('/api/academic-years', (r) => r.code) },
          { name: 'class_id', label: t('Class'), type: 'select', required: true, options: await options('/api/classes', (r) => `${r.code} (${r.academic_year_code})`) },
          { name: 'subject_id', label: 'Subject', type: 'select', required: true, options: await options('/api/subjects') }, { name: 'weekly_load', label: 'Periods per week', type: 'number' },
        ], {}, async (v) => { await api('/api/teaching-assignments', { method: 'POST', body: v }); table.reload(); }) }, `+ ${t('New')}`) : null), table.el);
      table.reload();
      return wrap;
    },
    dept: () => entityPanel({ id: 'dept', endpoint: '/api/departments', manage: 'staff.manage', title: t('Departments'),
      columns: [{ key: 'code', label: t('Code') }, { key: 'name', label: 'Name', render: (r) => nm(r.name_en, r.name_ar) }],
      fields: async () => [{ name: 'code', label: t('Code'), required: true }, { name: 'name_en', label: t('Name (English)'), required: true }, { name: 'name_ar', label: t('Name (Arabic)'), dir: 'rtl' }, { name: 'campus_id', label: t('Campus'), type: 'select', options: await options('/api/campuses') }] }),
  };
  const body = h('div');
  const show = (k) => body.replaceChildren(panels[k]());
  root.replaceChildren(pageHead(t('Staff')), tabs([['staff', t('Staff')], ['ta', t('Teaching assignments')], ['dept', t('Departments')]], show, 'staff'), body);
  show('staff');
}

// ---------------- Families, guardians, QR cards ----------------
export async function printCards(cards) {
  try { await loadScript('/vendor/qrcode.js'); } catch (e) { toast(e.message, 'error'); }
  const tn = state.me.tenant;
  const make = (c) => {
    let svg = h('div', { class: 'mono' }, c.token);
    if (window.qrcode) { const qr = window.qrcode(0, 'M'); qr.addData(c.token); qr.make(); svg = h('div', { html: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }); }
    return h('div', { class: 'qr-card' }, svg, h('div', {},
      h('div', { style: { fontWeight: 700 } }, tn.name_en), tn.name_ar ? h('div', { dir: 'rtl' }, tn.name_ar) : null,
      h('div', { class: 'ref' }, c.reference), h('div', {}, `Family ${c.family_code}`),
      h('div', { style: { marginTop: '4px' } }, 'Show at the gate. Staff will verify the collector.'),
      h('div', { dir: 'rtl' }, 'أظهر البطاقة عند البوابة. سيتحقق الموظف من هوية المستلم.'),
      h('div', { style: { fontSize: '0.8em', opacity: 0.7 } }, 'Developed by Noviqtek')));
  };
  const list = h('div', { class: 'cards' }, cards.map(make));
  let pr = document.getElementById('print-root');
  if (!pr) { pr = h('div', { id: 'print-root' }); document.body.append(pr); }
  pr.replaceChildren(h('div', { class: 'cards' }, cards.map(make)));
  modal(t('Print QR cards'), h('div', {}, h('div', { class: 'alert warn' }, 'These codes are shown only now. Printing again issues new cards and revokes these.'), list),
    [h('button', { class: 'btn primary', onclick: () => window.print() }, 'Print (A4, 85×54 mm cards)')]);
}
export async function familiesView(root) {
  const panels = {
    families: () => entityPanel({ id: 'fam', endpoint: '/api/families', manage: 'family.manage', title: t('Families'),
      columns: [{ key: 'family_code', label: t('Code'), render: (r) => h('span', { class: 'mono' }, r.family_code) }, { key: 'family_label', label: 'Label' }, { key: 'children', label: 'Children', num: true }, { key: 'active_cards', label: 'QR card', render: (r) => r.active_cards ? badge('Active', 'ok') : badge('None', 'muted') }],
      fields: async () => [{ name: 'family_code', label: t('Code'), required: true }, { name: 'family_label', label: 'Label' }, { name: 'preferred_language', label: t('Language'), type: 'select', options: [['en', 'English'], ['ar', 'العربية']] }],
      extraActions: (r, table) => can('family.credentials') ? [
        h('button', { class: 'btn sm', onclick: async () => { if (r.active_cards && !confirm('Issue a new card? The current card will stop working.')) return; const d = await api('/api/families/credentials/issue', { method: 'POST', body: { family_ids: [r.id] } }); await printCards(d.cards); table.reload(); } }, icon('qr'), 'Card'),
        r.active_cards ? h('button', { class: 'btn sm danger', onclick: async () => { const reason = prompt('Reason for revoking the card:'); if (!reason) return; const creds = await api(`/api/families/${r.id}/credentials`); const act = creds.rows.find((c) => c.status === 'active'); if (act) await api(`/api/family-credentials/${act.id}/revoke`, { method: 'POST', body: { reason } }); toast('Card revoked.'); table.reload(); } }, t('Revoke')) : null,
      ] : null }),
    guardians: () => entityPanel({ id: 'guard', endpoint: '/api/guardians', manage: 'family.manage', title: t('Guardians'),
      columns: [{ key: 'guardian_code', label: t('Code'), render: (r) => h('span', { class: 'mono' }, r.guardian_code) }, { key: 'name', label: 'Name', render: (r) => nm(r.official_name_en, r.official_name_ar) }, { key: 'phone', label: t('Phone'), render: (r) => h('span', { dir: 'ltr' }, r.phone || '') }, { key: 'email', label: t('Email') }, { key: 'verified_contact_status', label: 'Contact', render: (r) => badge(r.verified_contact_status || 'unverified', r.verified_contact_status === 'verified' ? 'ok' : 'muted') }, { key: 'portal_user', label: t('Portal'), render: (r) => r.portal_user ? badge('Linked', 'ok') : '' }],
      fields: async () => [{ name: 'guardian_code', label: t('Code'), required: true }, { name: 'official_name_en', label: t('Name (English)'), required: true }, { name: 'official_name_ar', label: t('Name (Arabic)'), dir: 'rtl' }, { name: 'phone', label: t('Phone'), hint: '+974 …' }, { name: 'email', label: t('Email'), type: 'email' }, { name: 'preferred_language', label: t('Language'), type: 'select', options: [['en', 'English'], ['ar', 'العربية']] }, { name: 'verified_contact_status', label: 'Contact verification', type: 'select', options: [['unverified', 'Unverified'], ['verified', 'Verified']] }, { name: 'address', label: 'Address', wide: true }] }),
  };
  const body = h('div');
  const show = (k) => body.replaceChildren(panels[k]());
  const batch = can('family.credentials') ? h('button', { class: 'btn', onclick: async () => {
    const all = await api('/api/families?size=200');
    const without = all.rows.filter((f) => !f.active_cards);
    if (!without.length) return toast('Every active family already has a card.');
    if (!confirm(`Issue and print cards for ${without.length} families without a card?`)) return;
    const d = await api('/api/families/credentials/issue', { method: 'POST', body: { family_ids: without.map((f) => f.id) } });
    printCards(d.cards);
  } }, icon('qr'), 'Print cards for families without one') : null;
  root.replaceChildren(pageHead(t('Families & guardians'), batch), tabs([['families', t('Families')], ['guardians', t('Guardians')]], show, 'families'), body);
  show('families');
}
