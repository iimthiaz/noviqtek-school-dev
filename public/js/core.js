// Core UI toolkit: DOM builder, API client, table, modal forms, toasts.
import { t, getLang } from '../i18n.js';

export const state = { me: null, csrf: '' };

// Views pass optional children (null/false when a section does not apply); never render them as text.
for (const m of ['replaceChildren', 'append', 'prepend']) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...kids) { return orig.apply(this, kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); };
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only used with trusted static strings
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);

const ICONS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z', users: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21a8 8 0 0 1 16 0',
  family: 'M7 8a3 3 0 1 0 0-.01M17 8a3 3 0 1 0 0-.01M2 20a5 5 0 0 1 10 0M12 20a5 5 0 0 1 10 0', book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21V5',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', check: 'M4 12l5 5L20 6', door: 'M6 3h10v18H6zM13 12h.01M16 21h3',
  staff: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2', upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  key: 'M15 7a4 4 0 1 1-3.5 6L4 20.5 3.5 17 5 15.5 7 17l1.5-1.5-2-2L11 9a4 4 0 0 1 4-2z', cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.8-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.8 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.8H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  log: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', menu: 'M4 6h16M4 12h16M4 18h16', moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18', out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  x: 'M6 6l12 12M18 6L6 18', rows: 'M3 6h18M3 12h18M3 18h18', qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM20 14v7M14 20h3',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01', user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
};
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONS[name] || ICONS.grid); svg.append(p);
  return svg;
}

export class ApiError extends Error {
  constructor(status, body) { super(body?.error?.message || `Request failed (${status})`); this.status = status; this.code = body?.error?.code; this.details = body?.error?.details; this.correlation = body?.error?.correlation_id; }
}
export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = { 'Accept': 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
  let res;
  try { res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
  catch { throw new ApiError(0, { error: { code: 'NETWORK', message: 'Cannot reach the server. Check your connection; nothing was saved.' } }); }
  if (raw && res.ok) return res;
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && !path.startsWith('/api/login')) { state.me = null; if (!location.hash.startsWith('#/login')) location.hash = '#/login'; }
    if (err.code === 'MFA_ENROLL_REQUIRED') location.hash = '#/mfa';
    throw err;
  }
  return data;
}
export const errText = (e) => e.message + (e.correlation ? ` (ref ${e.correlation})` : '');

export function toast(msg, type = '') {
  let box = $('.toasts');
  if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const el = h('div', { class: 'toast ' + type }, msg);
  box.append(el);
  setTimeout(() => el.remove(), type === 'error' ? 8000 : 3500);
}

export function badge(text, tone = 'muted') { return h('span', { class: 'badge b-' + tone }, text); }
const STATUS_TONE = { active: 'ok', archived: 'muted', invited: 'info', disabled: 'bad', withdrawn: 'warn', graduated: 'info', on_leave: 'warn', left: 'muted', present: 'ok', absent: 'bad', late: 'warn', excused: 'info', called: 'gold', dismissed: 'ok', revoked: 'bad', committed: 'ok', ended: 'muted' };
export const statusBadge = (s) => s ? badge(t(s), STATUS_TONE[s] || 'muted') : badge(t('unmarked'), 'muted');

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso);
  return new Intl.DateTimeFormat(getLang() === 'ar' ? 'ar-QA-u-nu-latn' : 'en-GB', iso.length === 10 ? { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' } : { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: state.me?.tenant?.timezone || 'Asia/Qatar' }).format(d);
}
export const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: state.me?.tenant?.timezone || 'Asia/Qatar' }).format(new Date());
export const can = (p) => !!state.me && state.me.permissions.includes(p);

function store(key, val) { try { if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null'); localStorage.setItem(key, JSON.stringify(val)); } catch { return null; } }
export { store };

// Data table with server paging, sorting, column selection (remembered per user device).
export function dataTable({ id, columns, fetchPage, rowActions, onRow, empty = t('No records found.'), pageSize = 25 }) {
  const saved = store('nq_cols_' + id) || {};
  const st = { page: 1, sort: null, dir: 'asc', hidden: new Set(saved.hidden || columns.filter((c) => c.hidden).map((c) => c.key)) };
  const wrap = h('div', { class: 'card' });
  const tableWrap = h('div', { class: 'table-wrap' });
  const pager = h('div', { class: 'pager' });
  const colBtn = h('button', { class: 'btn sm', type: 'button', 'aria-haspopup': 'true' }, icon('rows'), t('Columns'));
  colBtn.onclick = () => {
    const body = h('div', { class: 'grid-form' }, columns.map((c) => h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !st.hidden.has(c.key), onchange: (e) => { e.target.checked ? st.hidden.delete(c.key) : st.hidden.add(c.key); store('nq_cols_' + id, { hidden: [...st.hidden] }); render(); } }), c.label)));
    modal(t('Columns'), body, [h('button', { class: 'btn primary', 'data-close': '1' }, t('Close'))]);
  };
  let last = null;
  async function load() {
    tableWrap.replaceChildren(h('div', { class: 'card-pad' }, h('div', { class: 'skeleton' }), h('br'), h('div', { class: 'skeleton' })));
    try { last = await fetchPage({ page: st.page, size: pageSize, sort: st.sort, dir: st.dir }); render(); }
    catch (e) { tableWrap.replaceChildren(h('div', { class: 'alert error', role: 'alert' }, errText(e), ' ', h('button', { class: 'btn sm', onclick: load }, 'Retry'))); }
  }
  function render() {
    const cols = columns.filter((c) => !st.hidden.has(c.key));
    const head = h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'num' : '', scope: 'col', 'aria-sort': st.sort === c.sortKey ? (st.dir === 'asc' ? 'ascending' : 'descending') : null },
      c.sortKey ? h('button', { type: 'button', onclick: () => { st.dir = st.sort === c.sortKey && st.dir === 'asc' ? 'desc' : 'asc'; st.sort = c.sortKey; st.page = 1; load(); } }, c.label, st.sort === c.sortKey ? (st.dir === 'asc' ? ' ▲' : ' ▼') : '') : c.label)),
      rowActions ? h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, t('Actions'))) : null);
    const rows = last.rows.map((r) => h('tr', {}, cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : (r[c.key] ?? ''))),
      rowActions ? h('td', { style: { textAlign: 'end', whiteSpace: 'nowrap' } }, rowActions(r)) : null));
    tableWrap.replaceChildren(last.rows.length ? h('table', { class: 'data' }, h('thead', {}, head), h('tbody', {}, rows)) : h('div', { class: 'empty' }, empty));
    const pages = Math.max(1, Math.ceil(last.total / pageSize));
    pager.replaceChildren(h('span', {}, `${last.total} • ${st.page}/${pages}`), h('span', { class: 'row' }, colBtn,
      h('button', { class: 'btn sm', disabled: st.page <= 1, onclick: () => { st.page--; load(); } }, t('Previous')),
      h('button', { class: 'btn sm', disabled: st.page >= pages, onclick: () => { st.page++; load(); } }, t('Next'))));
  }
  wrap.append(tableWrap, pager);
  return { el: wrap, reload: (resetPage) => { if (resetPage) st.page = 1; return load(); } };
}

export function modal(title, body, actions = []) {
  const d = h('dialog', { class: 'modal', 'aria-labelledby': 'mt' },
    h('div', { class: 'modal-head' }, h('h2', { id: 'mt' }, title), h('button', { class: 'icon-btn', 'aria-label': t('Close'), 'data-close': '1' }, icon('x'))),
    h('div', { class: 'modal-body' }, body), actions.length ? h('div', { class: 'modal-foot' }, actions) : null);
  d.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) d.close(); });
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

// Declarative form. Field: {name, label, type, required, options:[[value,label]], hint}
export function form(fields, values = {}, { onSubmit, submitLabel = t('Save') } = {}) {
  const errBox = h('div', { role: 'alert' });
  const inputs = {};
  const grid = h('div', { class: 'grid-form' }, fields.map((f) => {
    let input;
    const v = values[f.name];
    if (f.type === 'select') input = h('select', { name: f.name, required: f.required }, f.required ? null : h('option', { value: '' }, '—'), (f.options || []).map(([val, lab]) => h('option', { value: val, selected: String(v ?? '') === String(val) }, lab)));
    else if (f.type === 'checkbox') input = h('input', { type: 'checkbox', name: f.name, checked: !!v, style: { width: '22px', height: '22px' } });
    else if (f.type === 'textarea') input = h('textarea', { name: f.name, rows: 3 }, v ?? '');
    else input = h('input', { type: f.type || 'text', name: f.name, value: v ?? '', required: f.required, maxlength: f.max || 200, dir: f.dir || null, autocomplete: f.autocomplete || 'off', inputmode: f.inputmode || null });
    inputs[f.name] = input;
    return h('label', { class: 'field', style: f.wide ? { gridColumn: '1 / -1' } : null }, h('span', {}, f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : ''), input, f.hint ? h('span', { class: 'hint' }, f.hint) : null);
  }));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const el = h('form', { novalidate: true }, errBox, grid, h('div', { class: 'row', style: { marginTop: '16px', justifyContent: 'flex-end' } }, btn));
  const read = () => Object.fromEntries(fields.map((f) => [f.name, f.type === 'checkbox' ? inputs[f.name].checked : (inputs[f.name].value.trim() === '' ? null : inputs[f.name].value.trim())]));
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.replaceChildren();
    const missing = fields.filter((f) => f.required && !read()[f.name]);
    for (const f of fields) inputs[f.name].removeAttribute('aria-invalid');
    if (missing.length) { missing.forEach((f) => inputs[f.name].setAttribute('aria-invalid', 'true')); errBox.replaceChildren(h('div', { class: 'alert error' }, 'Required: ' + missing.map((f) => f.label).join(', '))); inputs[missing[0].name].focus(); return; }
    btn.disabled = true;
    try { await onSubmit(read()); }
    catch (err) { errBox.replaceChildren(h('div', { class: 'alert error' }, errText(err))); } // typed values stay in place
    finally { btn.disabled = false; }
  });
  return { el, inputs, read };
}

export function formModal(title, fields, values, onSubmit) {
  let d;
  const f = form(fields, values, { onSubmit: async (v) => { await onSubmit(v); d.close(); } });
  d = modal(title, f.el);
  return d;
}

export function tabs(defs, onChange, initial) {
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const btns = defs.map(([key, label]) => h('button', { role: 'tab', type: 'button', 'aria-selected': key === initial ? 'true' : 'false', onclick: () => { btns.forEach((b) => b.setAttribute('aria-selected', 'false')); btns[defs.findIndex((d) => d[0] === key)].setAttribute('aria-selected', 'true'); onChange(key); } }, label));
  bar.append(...btns);
  return bar;
}

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = h('script', { src });
    s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src + '. Re-run the deploy script so vendor libraries are bundled.'));
    document.head.append(s);
  });
}
export function download(name, content, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const debounce = (fn, ms = 300) => { let tm; return (...a) => { clearTimeout(tm); tm = setTimeout(() => fn(...a), ms); }; };
