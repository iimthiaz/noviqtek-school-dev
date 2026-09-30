import { t, nm, getLang, setLang, applyLang } from './i18n.js';
import { h, api, state, icon, store, can, errText } from './js/core.js';
import * as A from './js/views-a.js';
import * as B from './js/views-b.js';

applyLang();
const theme = store('nq_theme'); if (theme) document.documentElement.dataset.theme = theme;
const density = store('nq_density'); if (density) document.documentElement.dataset.density = density;

// Public (signed-out) routes
const PUBLIC = [
  [/^#\/login$/, A.loginView], [/^#\/setup$/, (r) => A.setupView(r, null)], [/^#\/setup\/(.+)$/, A.setupView], [/^#\/invite\/(.+)$/, (r, m) => A.inviteView(r, m, 'invite')],
  [/^#\/reset\/(.+)$/, (r, m) => A.inviteView(r, m, 'password_reset')],
];
// Signed-in routes: [pattern, view, permission-or-predicate]
const ROUTES = [
  [/^#\/$/, A.dashboardView, () => can('dashboard.view')],
  [/^#\/students$/, A.studentsView, 'student.view'], [/^#\/students\/new$/, A.studentEditView, 'student.create'], [/^#\/students\/([\w-]+)$/, A.studentEditView, 'student.view'],
  [/^#\/families$/, A.familiesView, 'family.view'], [/^#\/classes$/, A.classesView, 'academic.view'], [/^#\/academics$/, A.academicsView, 'academic.view'],
  [/^#\/staff$/, A.staffView, 'staff.view'], [/^#\/attendance$/, B.attendanceView, 'attendance.view'], [/^#\/dismissal$/, B.dismissalView, 'dismissal.view'],
  [/^#\/import$/, B.importView, 'import.run'], [/^#\/users$/, B.usersView, () => can('user.manage') || can('role.manage')], [/^#\/settings$/, B.settingsView, 'tenant.configure'],
  [/^#\/audit$/, B.auditView, 'audit.view'], [/^#\/portal$/, B.portalView, () => state.me.is_guardian], [/^#\/account$/, B.accountView, () => true], [/^#\/mfa$/, B.mfaView, () => true],
];
const NAV = [
  ['Overview', [['#/', 'Dashboard', 'home', () => can('dashboard.view')], ['#/portal', 'My children', 'family', () => state.me.is_guardian]]],
  ['Admissions and Students', [['#/students', 'Students', 'users', 'student.view'], ['#/families', 'Families & guardians', 'family', 'family.view']]],
  ['Academics', [['#/classes', 'Classes', 'grid', 'academic.view'], ['#/academics', 'Academic setup', 'book', 'academic.view']]],
  ['Attendance and Dismissal', [['#/attendance', 'Attendance', 'check', 'attendance.view'], ['#/dismissal', 'Dismissal', 'door', 'dismissal.view']]],
  ['People', [['#/staff', 'Staff', 'staff', 'staff.view']]],
  ['Administration', [['#/import', 'Import Center', 'upload', 'import.run'], ['#/users', 'Users & roles', 'key', () => can('user.manage') || can('role.manage')], ['#/settings', 'School settings', 'cog', 'tenant.configure'], ['#/audit', 'Audit log', 'log', 'audit.view']]],
];
const allowed = (p) => typeof p === 'function' ? p() : can(p);

function applyBranding() {
  const tn = state.me?.tenant;
  if (!tn) return;
  document.documentElement.style.setProperty('--brand', tn.primary_color || '#1d4e89');
  document.documentElement.style.setProperty('--accent', tn.accent_color || '#0f8b8d');
  document.title = `${nm(tn.name_en, tn.name_ar)} · Noviqtek School Management`;
}

let content, sidebar;
function shell() {
  const tn = state.me.tenant;
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.map(([group, items]) => {
    const vis = items.filter((i) => allowed(i[3]));
    return vis.length ? h('div', { class: 'nav-group' }, h('h3', {}, t(group)), vis.map(([href, label, ic]) => h('a', { href, 'data-href': href }, icon(ic), t(label)))) : null;
  }));
  sidebar = h('aside', { class: 'sidebar', id: 'sidebar' },
    h('div', { class: 'brand' }, tn.logo_data ? h('img', { src: tn.logo_data, alt: '' }) : h('div', { class: 'mono', 'aria-hidden': 'true' }, (tn.code || 'S').slice(0, 2)),
      h('div', {}, h('b', {}, nm(tn.name_en, tn.name_ar) || t('School setup required.')), h('small', {}, 'Noviqtek School Management'))), nav);
  const toggleTheme = () => { const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = n; store('nq_theme', n); };
  const toggleDensity = () => { const n = document.documentElement.dataset.density === 'compact' ? 'comfortable' : 'compact'; document.documentElement.dataset.density = n; store('nq_density', n); };
  const top = h('header', { class: 'topbar' },
    h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Menu', 'aria-controls': 'sidebar', onclick: () => sidebar.classList.toggle('open') }, icon('menu')),
    h('div', { class: 'ctx' }, `${nm(tn.name_en, tn.name_ar)} • ${tn.timezone} • ${tn.currency}`), h('div', { class: 'grow' }),
    h('button', { class: 'icon-btn', title: t('Language'), 'aria-label': getLang() === 'ar' ? 'English' : 'العربية', onclick: () => { setLang(getLang() === 'ar' ? 'en' : 'ar'); boot(); } }, icon('globe')),
    h('button', { class: 'icon-btn', title: t('Theme'), 'aria-label': t('Theme'), onclick: toggleTheme }, icon('moon')),
    h('button', { class: 'icon-btn', title: t('Density'), 'aria-label': t('Density'), onclick: toggleDensity }, icon('rows')),
    h('a', { class: 'icon-btn', href: '#/account', title: t('My account'), 'aria-label': t('My account') }, icon('user')),
    h('button', { class: 'btn sm', onclick: async () => { try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ } state.me = null; location.hash = '#/login'; } }, icon('out'), t('Sign out')));
  content = h('main', { class: 'content', id: 'main', tabindex: '-1' });
  const app = document.getElementById('app');
  app.replaceChildren(h('a', { class: 'skip', href: '#main', onclick: (e) => { e.preventDefault(); content.focus(); } }, 'Skip to content'),
    h('div', { class: 'shell' }, sidebar, h('div', { class: 'main' }, top, content, h('footer', { class: 'footer' }, `${t('Developed by Noviqtek')} • ${state.me.user.display_name} • ${state.me.roles.map((r) => nm(r.name_en, r.name_ar)).join(', ')}`))));
}

let cleanup = null;
async function route() {
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  const hash = location.hash || '#/';
  for (const [re, view] of PUBLIC) {
    const m = hash.match(re);
    if (m) { const root = document.getElementById('app'); root.replaceChildren(); content = null; cleanup = await view(root, m); return; }
  }
  if (!state.me) {
    try { state.me = await api('/api/me'); state.csrf = state.me.csrf; } catch { location.hash = '#/login'; return; }
    applyBranding();
  }
  if (state.me.needs_mfa_enrollment && hash !== '#/mfa') { location.hash = '#/mfa'; return; }
  if (!content || !document.body.contains(content)) shell();
  sidebar.classList.remove('open');
  for (const a of sidebar.querySelectorAll('a[data-href]')) a.toggleAttribute('aria-current', false), a.getAttribute('data-href') === hash.split('?')[0] && a.setAttribute('aria-current', 'page');
  const r = ROUTES.find(([re]) => re.test(hash));
  if (!r) { location.hash = state.me.is_guardian && !can('dashboard.view') ? '#/portal' : (can('dashboard.view') ? '#/' : '#/account'); return; }
  if (!allowed(r[2])) { content.replaceChildren(h('div', { class: 'alert error', role: 'alert' }, 'You do not have access to this page.')); return; }
  content.replaceChildren(h('div', { class: 'card card-pad' }, h('div', { class: 'skeleton' })));
  try { cleanup = await r[1](content, hash.match(r[0])); }
  catch (e) { content.replaceChildren(h('div', { class: 'alert error', role: 'alert' }, errText(e))); }
}
export function boot() { content = null; state.me && applyBranding(); route(); }
window.addEventListener('hashchange', route);
window.addEventListener('nq:refresh-me', async () => { state.me = await api('/api/me'); state.csrf = state.me.csrf; applyBranding(); boot(); });
route();
