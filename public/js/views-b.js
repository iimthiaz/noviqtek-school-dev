import { t, nm, getLang } from '../i18n.js';
import { h, api, state, icon, can, errText, toast, badge, statusBadge, fmtDate, dataTable, modal, form, formModal, tabs, loadScript, download, debounce, todayLocal } from './core.js';
import { options } from './views-a.js';

const pageHead = (title, ...actions) => h('div', { class: 'page-head' }, h('h1', {}, title), ...actions);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

// ---------------- Attendance ----------------
export async function attendanceView(root) {
  const classes = await options('/api/classes', (r) => `${r.code} — ${nm(r.name_en, r.name_ar)}`);
  const pre = new URLSearchParams(location.hash.split('?')[1] || '').get('class');
  const st = { class_id: pre || classes[0]?.[0] || '', date: todayLocal(), dirty: new Map() };
  const body = h('div');
  const classSel = h('select', { 'aria-label': t('Class'), onchange: (e) => { if (confirmLeave()) { st.class_id = e.target.value; loadRegister(); } else e.target.value = st.class_id; } }, classes.map(([id, l]) => h('option', { value: id, selected: id === st.class_id }, l)));
  const dateIn = h('input', { type: 'date', value: st.date, max: todayLocal(), 'aria-label': t('Date'), onchange: (e) => { if (confirmLeave()) { st.date = e.target.value; current === 'reg' ? loadRegister() : loadSummary(); } else e.target.value = st.date; } });
  const confirmLeave = () => !st.dirty.size || confirm('You have unsaved attendance changes. Discard them?');
  let current = 'reg';

  async function loadRegister() {
    st.dirty.clear();
    if (!st.class_id) { body.replaceChildren(h('div', { class: 'empty' }, 'No classes available to you.')); return; }
    body.replaceChildren(h('div', { class: 'skeleton' }));
    const d = await api(`/api/attendance/register?class_id=${st.class_id}&date=${st.date}`);
    const past = st.date < d.today;
    const reason = h('input', { type: 'text', placeholder: 'Reason for correcting past attendance', maxlength: 300 });
    const saveBtn = h('button', { class: 'btn primary', disabled: true }, t('Save register'));
    const counter = h('span', { class: 'muted', role: 'status' });
    const refresh = () => { saveBtn.disabled = !st.dirty.size; counter.textContent = st.dirty.size ? `${st.dirty.size} unsaved` : ''; };
    const rows = d.rows.map((r) => {
      const cur = { status_code: r.status_code, minutes_late: r.minutes_late ?? '', note: r.note ?? '' };
      const tr = h('tr');
      const late = h('input', { type: 'number', min: 0, max: 600, value: cur.minutes_late, style: { width: '80px' }, 'aria-label': t('Minutes late'), hidden: cur.status_code !== 'late', disabled: !d.can_record });
      const note = h('input', { type: 'text', value: cur.note, maxlength: 500, 'aria-label': t('Note'), disabled: !d.can_record });
      const mark = () => { st.dirty.set(r.student_id, { student_id: r.student_id, status_code: cur.status_code, minutes_late: late.value, note: note.value }); tr.classList.add('dirty'); refresh(); };
      const seg = h('div', { class: 'seg', role: 'group', 'aria-label': `${t('Status')}: ${r.official_name_en}` }, ['present', 'absent', 'late', 'excused'].map((s) => h('button', {
        type: 'button', 'data-v': s, 'aria-pressed': cur.status_code === s ? 'true' : 'false', disabled: !d.can_record, title: t(s),
        onclick: (e) => { cur.status_code = s; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === e.currentTarget ? 'true' : 'false')); late.hidden = s !== 'late'; mark(); },
      }, t(s[0].toUpperCase() + s.slice(1)))));
      late.oninput = () => cur.status_code && mark(); note.oninput = () => cur.status_code && mark();
      tr.append(h('td', {}, h('b', {}, nm(r.official_name_en, r.official_name_ar)), h('div', { class: 'hint mono' }, r.admission_no)), h('td', {}, seg), h('td', {}, late), h('td', {}, note),
        h('td', {}, r.status_code ? h('span', { class: 'hint' }, `${statusBadge(r.status_code).textContent} · ${r.recorded_by_name || ''} ${fmtDate(r.recorded_at)}`) : statusBadge(null)));
      tr._mark = (s) => { if (!cur.status_code) seg.querySelector(`[data-v=${s}]`).click(); };
      return tr;
    });
    saveBtn.onclick = async () => {
      if (past && !reason.value.trim() && d.rows.some((r) => r.status_code && st.dirty.has(r.student_id))) { toast('Enter a reason for correcting past attendance.', 'error'); reason.focus(); return; }
      saveBtn.disabled = true;
      try {
        const r = await api('/api/attendance/register', { method: 'POST', body: { class_id: st.class_id, date: st.date, marks: [...st.dirty.values()], reason: reason.value } });
        toast(`Saved ${r.saved} record(s).`); st.dirty.clear(); loadRegister();
      } catch (e) { toast(errText(e), 'error'); refresh(); } // unsaved marks stay on screen
    };
    body.replaceChildren(
      !d.working_day ? h('div', { class: 'alert warn' }, 'This date is not a configured working day.') : null,
      !d.can_record ? h('div', { class: 'alert info' }, 'View only.') : null,
      h('div', { class: 'toolbar' }, d.can_record ? h('button', { class: 'btn', onclick: () => rows.forEach((tr) => tr._mark('present')) }, t('Mark all present')) : null,
        past && d.can_record ? reason : null, h('span', { class: 'spacer' }), counter, d.can_record ? saveBtn : null),
      h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, d.rows.length ? h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, [t('Students'), t('Status'), t('Minutes late'), t('Note'), 'Recorded'].map((x) => h('th', {}, x)))), h('tbody', {}, rows)) : h('div', { class: 'empty' }, 'No students enrolled in this class on this date.'))));
  }
  async function loadSummary() {
    const d = await api(`/api/attendance/summary?date=${st.date}`);
    const from = h('input', { type: 'date', value: st.date, 'aria-label': 'From' }); const to = h('input', { type: 'date', value: st.date, 'aria-label': 'To' });
    const T = d.totals;
    body.replaceChildren(
      h('div', { class: 'kpis' }, [['Enrolled', T.enrolled], ['Present', T.present], ['Late', T.late], ['Absent', T.absent], ['Excused', T.excused], ['unmarked', T.unmarked], ['Attendance rate', T.attendance_rate === null ? '—' : T.attendance_rate + '%']]
        .map(([l, v]) => h('div', { class: 'card kpi' }, h('div', { class: 'label' }, t(l)), h('div', { class: 'value' }, String(v))))),
      h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, [t('Class'), t('Enrolled'), t('Present'), t('Late'), t('Absent'), t('Excused'), t('unmarked')].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
        h('tbody', {}, d.classes.map((c) => h('tr', {}, h('td', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); st.class_id = c.class_id; classSel.value = c.class_id; tabBar.querySelector('button').click(); } }, c.code)),
          ...['enrolled', 'present', 'late', 'absent', 'excused', 'unmarked'].map((k) => h('td', { class: 'num' }, String(c[k] || 0))))))))),
      h('details', { class: 'card card-pad', style: { marginTop: '12px' } }, h('summary', {}, 'Definitions'), h('ul', {}, Object.entries(d.definitions).map(([k, v]) => h('li', {}, h('b', {}, k + ': '), v)))),
      h('div', { class: 'toolbar', style: { marginTop: '12px' } }, 'Export', from, to, h('button', { class: 'btn', onclick: () => { location.href = `/api/attendance/export?from=${from.value}&to=${to.value}`; } }, t('Export CSV'))));
  }
  const tabBar = tabs([['reg', t('Register')], ['sum', t('Summary')]], (k) => { if (!confirmLeave()) return; current = k; k === 'reg' ? loadRegister() : loadSummary(); }, 'reg');
  root.replaceChildren(pageHead(t('Attendance'), classSel, dateIn), tabBar, body);
  await loadRegister();
  const warn = (e) => { if (st.dirty.size) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', warn);
  return () => window.removeEventListener('beforeunload', warn);
}

// ---------------- Dismissal ----------------
export async function dismissalView(root) {
  let timer = null, lastOk = Date.now(), stopScan = null;
  const body = h('div');
  const staleBox = h('div', { class: 'stale', role: 'alert', hidden: true }, t('Connection is stale — data may be out of date.'));
  const syncInfo = h('span', { class: 'muted', role: 'status' });
  const stop = () => { clearInterval(timer); timer = null; if (stopScan) stopScan(); stopScan = null; };

  function card(r, allowConfirm) {
    const cls = r.status === 'called' ? 'called' : r.status === 'dismissed' ? 'dismissed' : '';
    return h('div', { class: `card dcard ${cls}` },
      h('div', { class: 'row' }, h('span', { class: 'who spacer' }, nm(r.official_name_en, r.official_name_ar)), r.status === 'called' ? badge(t('Called'), 'gold') : r.status === 'dismissed' ? badge(t('Dismissed'), 'ok') : badge(t('Not called'), 'muted')),
      h('div', { class: 'hint' }, `${r.class_code}${r.called_at ? ' · ' + t('Called') + ' ' + fmtDate(r.called_at) + ' (' + r.channel + ')' : ''}${r.dismissed_at ? ' · ' + t('Dismissed') + ' ' + fmtDate(r.dismissed_at) : ''}${r.attendance === 'absent' ? ' · ' + t('absent') : ''}`),
      allowConfirm && r.status === 'called' && can('dismissal.confirm') ? h('button', { class: 'btn accent big', onclick: async (e) => { e.currentTarget.disabled = true; try { await api(`/api/dismissal/${r.record_id}/dismiss`, { method: 'POST' }); poll(); } catch (err) { toast(errText(err), 'error'); } } }, t('Confirm dismissal')) : null,
      r.status && can('dismissal.reopen') ? h('button', { class: 'btn sm', onclick: async () => { const reason = prompt('Reason for reopening this record:'); if (!reason) return; await api(`/api/dismissal/${r.record_id}/reopen`, { method: 'POST', body: { reason } }); poll(); } }, 'Reopen') : null);
  }
  let boardData = null, boardFilter = { q: '', class_id: '', view: '' };
  async function poll() {
    try {
      boardData = await api('/api/dismissal/board?' + new URLSearchParams({ class_id: boardFilter.class_id, view: boardFilter.view }));
      lastOk = Date.now(); staleBox.hidden = true;
      syncInfo.textContent = `${t('Last updated')}: ${new Date().toLocaleTimeString(getLang() === 'ar' ? 'ar-QA-u-nu-latn' : 'en-GB')} · ${t('Called')} ${boardData.counts.called} · ${t('Dismissed')} ${boardData.counts.dismissed}`;
      renderBoard?.();
    } catch { if (Date.now() - lastOk > 10000) staleBox.hidden = false; }
  }
  let renderBoard = null;
  const startPolling = () => { stop(); poll(); timer = setInterval(() => { if (Date.now() - lastOk > 10000) staleBox.hidden = false; poll(); }, 3000); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && timer) poll(); });

  function boardPanel() {
    const list = h('div', { class: 'dgrid', 'aria-live': 'polite' });
    renderBoard = () => {
      const qv = boardFilter.q.toLowerCase();
      const rows = boardData.rows.filter((r) => !qv || `${r.official_name_en} ${r.official_name_ar || ''} ${r.class_code}`.toLowerCase().includes(qv));
      list.replaceChildren(...(rows.length ? rows.map((r) => card(r, true)) : [h('div', { class: 'empty' }, boardData.scoped ? 'No students in your classes today.' : 'No students called yet today.')]));
    };
    return h('div', {}, h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: t('Search'), 'aria-label': t('Search'), oninput: (e) => { boardFilter.q = e.target.value; renderBoard(); } }),
      h('span', { class: 'spacer' }), syncInfo), list);
  }
  function receptionPanel() {
    boardFilter.view = 'all';
    const list = h('div', { class: 'dgrid' });
    const sel = new Set();
    const callBtn = h('button', { class: 'btn primary big', disabled: true }, t('Call for pickup'));
    const upd = () => { callBtn.disabled = !sel.size; callBtn.textContent = `${t('Call for pickup')}${sel.size ? ` (${sel.size})` : ''}`; };
    renderBoard = () => {
      const qv = boardFilter.q.toLowerCase();
      const rows = qv.length < 2 ? boardData.rows.filter((r) => r.status === 'called') : boardData.rows.filter((r) => `${r.official_name_en} ${r.official_name_ar || ''} ${r.class_code}`.toLowerCase().includes(qv)).slice(0, 60);
      list.replaceChildren(...(rows.length ? rows.map((r) => {
        const c = card(r, false);
        if (!r.status && r.attendance !== 'absent') c.prepend(h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: sel.has(r.student_id), style: { width: '22px', height: '22px' }, onchange: (e) => { e.target.checked ? sel.add(r.student_id) : sel.delete(r.student_id); upd(); } }), 'Select'));
        return c;
      }) : [h('div', { class: 'empty' }, qv.length < 2 ? 'Type at least 2 letters of a name or class to find students.' : t('No records found.'))]));
    };
    callBtn.onclick = async () => {
      callBtn.disabled = true;
      try {
        const r = await api('/api/dismissal/call', { method: 'POST', body: { student_ids: [...sel], channel: 'reception', idempotency_key: uuid() } });
        toast(`${r.newly_called} called${r.excluded.length ? `, ${r.excluded.length} not called: ${r.excluded.map((x) => `${x.name} (${x.reason.replace(/_/g, ' ')})`).join(', ')}` : ''}`);
        sel.clear(); upd(); poll();
      } catch (e) { toast(errText(e), 'error'); upd(); }
    };
    return h('div', {}, h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: 'Find student by name or class…', 'aria-label': t('Search'), oninput: (e) => { boardFilter.q = e.target.value; renderBoard(); } }), h('span', { class: 'spacer' }), callBtn), syncInfo, list);
  }
  function scanPanel() {
    renderBoard = null;
    const out = h('div');
    const manual = h('input', { type: 'text', placeholder: 'Scan with a handheld scanner or type the card code', 'aria-label': 'Family card code', autocomplete: 'off' });
    const video = h('video', { playsinline: true, muted: true });
    const camBox = h('div', { class: 'scan-box', hidden: true }, video);
    let busy = false;
    async function handle(token) {
      if (busy) return; busy = true;
      try {
        const d = await api('/api/dismissal/family-lookup', { method: 'POST', body: { token } });
        const chosen = new Set(d.children.filter((c) => c.eligible).map((c) => c.student_id));
        const go = h('button', { class: 'btn primary big' }, `${t('Call for pickup')} (${chosen.size})`);
        go.disabled = !chosen.size;
        go.onclick = async () => {
          go.disabled = true;
          try {
            const r = await api('/api/dismissal/checkin', { method: 'POST', body: { token, student_ids: [...chosen], idempotency_key: uuid() } });
            out.replaceChildren(h('div', { class: 'alert info', role: 'status' }, `${d.family.card_reference}: ${r.newly_called} called.`, r.excluded.length ? ` Not called: ${r.excluded.map((x) => `${x.name} (${x.reason.replace(/_/g, ' ')})`).join(', ')}` : ''));
          } catch (e) { toast(errText(e), 'error'); go.disabled = false; }
        };
        out.replaceChildren(h('div', { class: 'card card-pad' },
          h('h2', {}, `${d.family.card_reference} · ${d.family.label || d.family.code}`),
          h('div', { class: 'alert warn' }, d.notice),
          h('p', {}, h('b', {}, 'Authorised collectors: '), d.authorized_collectors.map((c) => `${nm(c.official_name_en, c.official_name_ar)} (${c.relationship_code})`).join(', ') || 'None recorded'),
          h('div', { class: 'dgrid' }, d.children.map((c) => h('label', { class: 'card dcard' }, h('span', { class: 'row' },
            h('input', { type: 'checkbox', checked: chosen.has(c.student_id), disabled: !c.eligible, style: { width: '22px', height: '22px' }, onchange: (e) => { e.target.checked ? chosen.add(c.student_id) : chosen.delete(c.student_id); go.textContent = `${t('Call for pickup')} (${chosen.size})`; go.disabled = !chosen.size; } }),
            h('span', { class: 'who' }, nm(c.name, c.name_ar))), h('span', { class: 'hint' }, `${c.class_code || ''} ${c.reason ? '· ' + c.reason.replace(/_/g, ' ') : ''}`)))),
          h('div', { class: 'row', style: { marginTop: '12px' } }, go, h('button', { class: 'btn', onclick: () => out.replaceChildren() }, t('Cancel')))));
      } catch (e) { out.replaceChildren(h('div', { class: 'alert error', role: 'alert' }, errText(e))); }
      finally { busy = false; manual.value = ''; }
    }
    manual.onkeydown = (e) => { if (e.key === 'Enter' && manual.value.trim()) handle(manual.value.trim()); };
    const camBtn = h('button', { class: 'btn', onclick: async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream; await video.play(); camBox.hidden = false;
        let detector = null;
        if ('BarcodeDetector' in window) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        else await loadScript('/vendor/jsQR.js');
        const canvas = document.createElement('canvas'); const ctx2 = canvas.getContext('2d', { willReadFrequently: true });
        let alive = true;
        stopScan = () => { alive = false; stream.getTracks().forEach((tr) => tr.stop()); camBox.hidden = true; };
        const tick = async () => {
          if (!alive) return;
          try {
            let val = null;
            if (detector) { const codes = await detector.detect(video); val = codes[0]?.rawValue; }
            else if (window.jsQR && video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; ctx2.drawImage(video, 0, 0); const img = ctx2.getImageData(0, 0, canvas.width, canvas.height); val = window.jsQR(img.data, img.width, img.height)?.data; }
            if (val && !busy) await handle(val);
          } catch { /* keep scanning */ }
          setTimeout(tick, 350);
        };
        tick();
      } catch (e) { toast('Camera unavailable: ' + e.message + ' — use a handheld scanner or type the code.', 'error'); }
    } }, icon('qr'), 'Use camera');
    setTimeout(() => manual.focus(), 50);
    return h('div', {}, h('div', { class: 'toolbar' }, manual, camBtn, h('button', { class: 'btn', onclick: () => stopScan && stopScan() }, 'Stop camera')), camBox, out);
  }

  const panels = { board: boardPanel, reception: receptionPanel, scan: scanPanel };
  const show = (k) => { boardFilter = { q: '', class_id: '', view: '' }; if (stopScan) stopScan(); body.replaceChildren(panels[k]()); if (k !== 'scan') startPolling(); else stop(); };
  const defs = [['board', t('Live board')]];
  if (can('dismissal.call')) defs.unshift(['reception', t('Reception call')], ['scan', t('Scan family QR')]);
  root.replaceChildren(pageHead(t('Dismissal'), h('span', { class: 'muted' }, fmtDate(todayLocal()))), staleBox, tabs(defs, show, defs[0][0]), body);
  show(defs[0][0]);
  return stop;
}

// ---------------- Import Center ----------------
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = (rows.shift() || []).map((x) => x.trim());
  return rows.filter((r) => r.some((x) => x.trim() !== '')).map((r) => Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])));
}
const csvCell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (cols, rows) => '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');

export async function importView(root) {
  const defs = await api('/api/imports/definitions');
  const body = h('div');
  const jobs = h('div');
  async function loadJobs() {
    const j = await api('/api/imports/jobs');
    jobs.replaceChildren(h('h2', {}, 'Import history'), j.rows.length ? h('div', { class: 'card table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ['When', 'Module', 'Mode', 'File', 'Created', 'Updated', 'Unchanged', 'Errors', 'By'].map((x) => h('th', {}, x)))),
      h('tbody', {}, j.rows.map((r) => h('tr', {}, h('td', {}, fmtDate(r.committed_at)), h('td', {}, r.module), h('td', {}, r.mode), h('td', {}, r.file_name || ''), h('td', { class: 'num' }, r.created_count), h('td', { class: 'num' }, r.updated_count), h('td', { class: 'num' }, r.unchanged_count), h('td', { class: 'num' }, r.error_rows), h('td', {}, r.by_name || ''))))))
      : h('p', { class: 'muted' }, 'No imports yet.'));
  }
  const dictRows = (m) => m.fields.map((f) => ({ key: f.key, label_en: f.label_en, label_ar: f.label_ar, type: f.type, required: f.required ? 'yes' : 'no', max_length: f.max, allowed_values: (f.values || []).join(' | '), example: f.example || '', sensitivity: f.sensitivity, unique: f.unique ? 'yes' : '', reference: f.ref || '', update_behavior: f.update_behavior, notes: f.desc || '' }));
  async function xlsxTemplate(m) {
    await loadScript('/vendor/xlsx.full.min.js');
    const X = window.XLSX; const wb = X.utils.book_new();
    const instr = [[`Noviqtek School Management — ${m.title} import template`], [`Schema version ${m.schema_version}. Developed by Noviqtek.`], [],
      ['1. Enter one record per row on the "Data" sheet. Row 1 holds the column keys — do not rename them.'], ['2. Required columns are marked * in the Field Dictionary.'],
      ['3. Dates must be YYYY-MM-DD. Identifiers are text; leading zeros are kept.'], ['4. Blank cells on update keep existing values. Type __CLEAR__ to empty an optional value.'],
      ['5. Only the "Data" sheet is imported. Examples are on the "Examples" sheet and are never imported.'], ['6. Do not add a school or tenant column — the school comes from your signed-in session.'],
      ['7. Save as .xlsx (macro-enabled files are rejected).'], [], m.note ? [m.note] : []];
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(instr), 'Instructions');
    const keys = m.fields.map((f) => f.key);
    const data = X.utils.aoa_to_sheet([keys]);
    // Text format for every column so Excel keeps leading zeros and ISO dates.
    for (let c = 0; c < keys.length; c++) for (let r = 1; r < 1000; r++) { const ref = X.utils.encode_cell({ r, c }); data[ref] = { t: 's', v: '', z: '@' }; }
    data['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 999, c: keys.length - 1 } });
    data['!cols'] = keys.map((k) => ({ wch: Math.max(14, k.length + 4) }));
    data['!freeze'] = { xSplit: 0, ySplit: 1 }; data['!views'] = [{ state: 'frozen', ySplit: 1 }];
    X.utils.book_append_sheet(wb, data, 'Data');
    X.utils.book_append_sheet(wb, X.utils.json_to_sheet(dictRows(m).map((r) => ({ ...r, key: r.key + (r.required === 'yes' ? ' *' : '') }))), 'Field Dictionary');
    const lookups = m.fields.filter((f) => f.values).flatMap((f) => f.values.map((v) => ({ column: f.key, allowed_value: v })));
    X.utils.book_append_sheet(wb, X.utils.json_to_sheet(lookups.length ? lookups : [{ column: '', allowed_value: 'No fixed lists in this template' }]), 'Lookup Values');
    X.utils.book_append_sheet(wb, X.utils.json_to_sheet([Object.fromEntries(m.fields.map((f) => [f.key, f.example || '']))]), 'Examples');
    X.writeFile(wb, `noviqtek-${m.module}-template-v${m.schema_version}.xlsx`);
  }
  async function readFile(file) {
    if (file.size > 5 * 1024 * 1024) throw new Error('File is larger than 5 MB. Split it into smaller files.');
    const name = file.name.toLowerCase();
    if (name.endsWith('.csv')) return { rows: parseCsv(await file.text()) };
    if (name.endsWith('.xlsx')) {
      await loadScript('/vendor/xlsx.full.min.js');
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, bookVBA: true });
      if (wb.vbaraw) throw new Error('Macro content was found. Save the file as a plain .xlsx without macros.');
      const ws = wb.Sheets.Data || wb.Sheets[wb.SheetNames.find((n) => !['Instructions', 'Field Dictionary', 'Lookup Values', 'Examples'].includes(n))];
      if (!ws) throw new Error('No "Data" sheet found.');
      const rows = window.XLSX.utils.sheet_to_json(ws, { defval: '', raw: true }).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [String(k).trim(), v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : String(v)])));
      return { rows };
    }
    throw new Error('Upload a .xlsx or .csv file.');
  }
  function modulePanel(m) {
    const st = { rows: null, file: null, mode: 'upsert', result: null };
    const out = h('div');
    const fileIn = h('input', { type: 'file', accept: '.xlsx,.csv', 'aria-label': t('Upload file') });
    const modeSel = h('select', { 'aria-label': t('Mode'), onchange: (e) => { st.mode = e.target.value; } }, [['upsert', 'Create or update (upsert)'], ['create', 'Create only'], ['update', 'Update only']].map(([v, l]) => h('option', { value: v }, l)));
    const validateBtn = h('button', { class: 'btn primary', disabled: true }, t('Validate'));
    fileIn.onchange = async () => {
      out.replaceChildren(); st.rows = null; validateBtn.disabled = true;
      const f = fileIn.files[0]; if (!f) return;
      try { const r = await readFile(f); st.rows = r.rows; st.file = f.name; validateBtn.disabled = false; out.replaceChildren(h('div', { class: 'alert info' }, `${r.rows.length} data rows read from ${f.name}.`)); }
      catch (e) { out.replaceChildren(h('div', { class: 'alert error' }, e.message)); }
    };
    validateBtn.onclick = async () => {
      validateBtn.disabled = true;
      try {
        const v = await api('/api/imports/validate', { method: 'POST', body: { module: m.module, mode: st.mode, rows: st.rows, file_name: st.file, schema_version: m.schema_version } });
        const s = v.summary;
        const validOnly = h('input', { type: 'checkbox' }); const confirmClear = h('input', { type: 'checkbox' });
        const commitBtn = h('button', { class: 'btn accent', disabled: !!s.file_errors.length || (s.invalid && !m.allowValidOnly) || !(s.creates + s.updates) || !!v.already_committed }, t('Commit import'));
        commitBtn.onclick = async () => {
          commitBtn.disabled = true;
          try {
            const r = await api('/api/imports/commit', { method: 'POST', body: { module: m.module, mode: st.mode, rows: st.rows, file_name: st.file, file_hash: v.file_hash, valid_only: validOnly.checked, confirm_clear: confirmClear.checked } });
            toast(`Imported: ${r.summary.creates} created, ${r.summary.updates} updated.`);
            out.replaceChildren(h('div', { class: 'alert info' }, `Job ${r.job_id} committed: ${r.summary.creates} created, ${r.summary.updates} updated, ${r.summary.unchanged} unchanged, ${r.summary.invalid} skipped.`),
              h('button', { class: 'btn', onclick: () => download(`import-result-${r.job_id}.csv`, toCsv(['row', 'action', 'errors'], r.actions.map((a) => ({ ...a, errors: (r.errors.find((e) => e.row === a.row)?.errors || []).map((e) => `${e.column} ${e.message}`).join('; ') })))) }, 'Download result log'));
            loadJobs();
          } catch (e) { toast(errText(e), 'error'); commitBtn.disabled = false; }
        };
        out.replaceChildren(
          h('div', { class: 'kpis' }, [['Rows', s.total], ['Valid', s.valid], ['Errors', s.invalid], ['Create', s.creates], ['Update', s.updates], ['Unchanged', s.unchanged]].map(([l, n]) => h('div', { class: 'card kpi' + (l === 'Errors' && n ? ' warn' : '') }, h('div', { class: 'label' }, l), h('div', { class: 'value' }, String(n))))),
          v.already_committed ? h('div', { class: 'alert warn' }, `This exact file was already imported on ${fmtDate(v.already_committed.committed_at)}. Committing again is blocked.`) : null,
          ...s.file_errors.map((e) => h('div', { class: 'alert error' }, e)),
          s.unknown_columns.length ? h('div', { class: 'alert warn' }, `Ignored unknown columns: ${s.unknown_columns.join(', ')}`) : null,
          v.errors.length ? h('div', { class: 'card table-wrap', style: { marginBottom: '12px' } }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, 'Row'), h('th', {}, 'Column'), h('th', {}, 'Problem'), h('th', {}, 'Value'))),
            h('tbody', {}, v.errors.flatMap((r) => r.errors.map((e) => h('tr', {}, h('td', { class: 'num' }, r.row), h('td', { class: 'mono' }, e.column), h('td', {}, e.message), h('td', { class: 'mono' }, e.value || ''))))))) : null,
          v.changes.length ? h('details', { class: 'card card-pad', style: { marginBottom: '12px' } }, h('summary', {}, `Changed fields (${v.changes.length} rows)`), h('ul', {}, v.changes.map((c) => h('li', {}, `Row ${c.row}: `, Object.entries(c.changes).map(([k, x]) => `${k}: "${x.from ?? ''}" → "${x.to ?? ''}"`).join('; '))))) : null,
          h('div', { class: 'row' }, s.invalid && m.allowValidOnly ? h('label', { class: 'row' }, validOnly, 'Import valid rows only') : null,
            v.changes.some((c) => Object.values(c.changes).some((x) => x.to === null)) ? h('label', { class: 'row' }, confirmClear, 'Confirm clearing values marked __CLEAR__') : null,
            h('span', { class: 'spacer' }), s.invalid && !m.allowValidOnly ? h('span', { class: 'err-text' }, 'All-or-nothing module: fix every error first.') : null, commitBtn));
      } catch (e) { out.replaceChildren(h('div', { class: 'alert error' }, errText(e))); }
      finally { validateBtn.disabled = !st.rows; }
    };
    return h('div', { class: 'card card-pad' },
      h('div', { class: 'row' }, h('h2', { class: 'spacer' }, m.title), badge(`schema v${m.schema_version}`, 'info')), m.note ? h('p', { class: 'hint' }, m.note) : null,
      h('div', { class: 'toolbar' }, h('button', { class: 'btn', onclick: () => xlsxTemplate(m).catch((e) => toast(e.message, 'error')) }, `${t('Download template')} (.xlsx)`),
        h('button', { class: 'btn', onclick: () => download(`noviqtek-${m.module}-template.csv`, toCsv(m.fields.map((f) => f.key), [])) }, 'CSV template'),
        h('button', { class: 'btn', onclick: () => download(`noviqtek-${m.module}-dictionary.csv`, toCsv(Object.keys(dictRows(m)[0]), dictRows(m))) }, 'Field dictionary (CSV)')),
      h('details', {}, h('summary', {}, `Fields (${m.fields.length})`), h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ['Key', 'English', 'العربية', 'Type', 'Required', 'Allowed / example'].map((x) => h('th', {}, x)))),
        h('tbody', {}, m.fields.map((f) => h('tr', {}, h('td', { class: 'mono' }, f.key), h('td', {}, f.label_en), h('td', { dir: 'rtl' }, f.label_ar), h('td', {}, f.type + (f.ref ? ' → ' + f.ref : '')), h('td', {}, f.required ? badge('Required', 'warn') : ''), h('td', {}, (f.values || []).join(' | ') || f.example || ''))))))),
      h('div', { class: 'toolbar', style: { marginTop: '12px' } }, fileIn, modeSel, validateBtn), out);
  }
  const list = h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Template'), h('th', {}, 'Fields'), h('th', {}, ''))),
    h('tbody', {}, defs.modules.map((m) => h('tr', {}, h('td', { class: 'num' }, m.order), h('td', {}, m.title), h('td', { class: 'num' }, m.fields.length),
      h('td', {}, m.allowed ? h('button', { class: 'btn sm primary', onclick: () => { body.replaceChildren(modulePanel(m)); body.scrollIntoView({ behavior: 'smooth' }); } }, 'Open') : badge('No permission', 'muted'))))))));
  root.replaceChildren(pageHead(t('Import Center')), h('div', { class: 'alert info' }, 'Import in the listed order so references resolve (campuses → years → classes → staff → students → enrollments → families → guardians → links). Validation never changes data; only "Commit import" does, and the same file cannot be committed twice.'),
    h('div', { style: { display: 'grid', gap: '16px' } }, list, body, jobs));
  loadJobs();
}

// ---------------- Users & roles ----------------
export async function usersView(root) {
  const body = h('div');
  const rolesData = await api('/api/roles');
  const roleOpts = rolesData.roles;
  const roleChecks = (selected = []) => h('fieldset', { style: { border: 0, padding: 0, gridColumn: '1 / -1' } }, h('legend', { class: 'hint' }, t('Roles')),
    h('div', { class: 'grid-form' }, roleOpts.map((r) => h('label', { class: 'row' }, h('input', { type: 'checkbox', value: r.id, checked: selected.includes(r.id) }), nm(r.name_en, r.name_ar), r.requires_mfa ? badge('MFA', 'info') : ''))));
  const showLink = (path, what) => modal(what, h('div', {}, h('p', {}, 'Send this one-time link to the person through a trusted channel. It is shown only now.'),
    h('input', { type: 'text', readonly: true, value: location.origin + path, onclick: (e) => e.target.select() }),
    h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: () => navigator.clipboard.writeText(location.origin + path).then(() => toast('Copied.')) }, 'Copy link'))));
  const usersPanel = () => {
    const table = dataTable({ id: 'users', columns: [
      { key: 'display_name', label: 'Name' }, { key: 'email', label: t('Email') }, { key: 'roles', label: t('Roles') },
      { key: 'link', label: 'Linked record', render: (r) => r.staff_code ? badge('Staff ' + r.staff_code, 'info') : r.guardian_code ? badge('Guardian ' + r.guardian_code, 'info') : '' },
      { key: 'mfa_enabled', label: 'MFA', render: (r) => r.mfa_enabled ? badge('On', 'ok') : badge('Off', 'muted') },
      { key: 'status', label: t('Status'), render: (r) => statusBadge(r.status) }, { key: 'last_login_at', label: 'Last sign-in', render: (r) => fmtDate(r.last_login_at) }],
      fetchPage: ({ page, size }) => api(`/api/users?page=${page}&size=${size}&q=${encodeURIComponent(body.dataset.q || '')}`),
      rowActions: (r) => [
        h('button', { class: 'btn sm', onclick: () => { const rc = roleChecks(r.role_ids); let d; const save = h('button', { class: 'btn primary', onclick: async () => { try { await api(`/api/users/${r.id}/roles`, { method: 'PUT', body: { role_ids: [...rc.querySelectorAll('input:checked')].map((x) => x.value) } }); toast('Roles updated. Takes effect on the next request.'); d.close(); table.reload(); } catch (e) { toast(errText(e), 'error'); } } }, t('Save')); d = modal(`${t('Roles')} — ${r.display_name}`, rc, [save]); } }, t('Roles')),
        r.id !== state.me.user.id ? h('button', { class: 'btn sm', onclick: async () => { const disable = r.status !== 'disabled'; const reason = prompt(disable ? 'Reason for disabling (sessions are revoked immediately):' : 'Reason for re-enabling:'); if (reason === null) return; try { await api(`/api/users/${r.id}/status`, { method: 'POST', body: { status: disable ? 'disabled' : 'active', reason } }); table.reload(); } catch (e) { toast(errText(e), 'error'); } } }, r.status === 'disabled' ? 'Enable' : 'Disable') : null,
        h('button', { class: 'btn sm', onclick: async () => { try { const d = await api(`/api/users/${r.id}/reset-link`, { method: 'POST' }); showLink(d.path, 'Password link'); } catch (e) { toast(errText(e), 'error'); } } }, 'Reset link'),
        r.mfa_enabled ? h('button', { class: 'btn sm danger', onclick: async () => { const reason = prompt('Reason for resetting two-factor authentication:'); if (!reason) return; await api(`/api/users/${r.id}/reset-mfa`, { method: 'POST', body: { reason } }); table.reload(); } }, 'Reset MFA') : null,
      ] });
    const invite = async () => {
      const staff = await options('/api/staff', (r) => `${r.staff_code} — ${r.official_name_en}`).catch(() => []);
      const guardians = await options('/api/guardians', (r) => `${r.guardian_code} — ${r.official_name_en}`).catch(() => []);
      const rc = roleChecks();
      let d;
      const f = form([{ name: 'display_name', label: 'Name', required: true }, { name: 'email', label: t('Email'), type: 'email', required: true },
        { name: 'staff_id', label: 'Link to staff record', type: 'select', options: staff }, { name: 'guardian_id', label: 'Link to guardian record', type: 'select', options: guardians }], {}, {
        submitLabel: t('Invite user'),
        onSubmit: async (v) => { const r = await api('/api/users/invite', { method: 'POST', body: { ...v, role_ids: [...rc.querySelectorAll('input:checked')].map((x) => x.value) } }); d.close(); table.reload(); showLink(r.invite_path, `Invitation (valid ${r.expires_days} days)`); },
      });
      f.el.querySelector('.grid-form').append(rc);
      d = modal(t('Invite user'), f.el);
    };
    const wrap = h('div', {}, h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: t('Search'), 'aria-label': t('Search'), oninput: debounce((e) => { body.dataset.q = e.target.value; table.reload(true); }) }), h('span', { class: 'spacer' }),
      can('user.manage') ? h('button', { class: 'btn primary', onclick: invite }, `+ ${t('Invite user')}`) : null), table.el);
    table.reload();
    return wrap;
  };
  const rolesPanel = async () => {
    const [{ permissions }, { roles }] = await Promise.all([api('/api/permissions'), api('/api/roles')]);
    const editor = (role) => {
      const boxes = h('div', { class: 'grid-form' }, Object.entries(permissions).map(([k, desc]) => h('label', { class: 'row', title: desc }, h('input', { type: 'checkbox', value: k, checked: role ? role.permissions.includes(k) : false, disabled: role?.code === 'school_super_admin' }), h('span', {}, h('span', { class: 'mono' }, k), h('br'), h('span', { class: 'hint' }, desc)))));
      const mfa = h('input', { type: 'checkbox', checked: role ? !!role.requires_mfa : true });
      const codeIn = h('input', { type: 'text', placeholder: 'custom_role_code' }); const nameIn = h('input', { type: 'text', placeholder: 'Role name' }); const nameAr = h('input', { type: 'text', dir: 'rtl', placeholder: 'اسم الدور' });
      let d;
      const save = h('button', { class: 'btn primary', onclick: async () => {
        const perms = [...boxes.querySelectorAll('input:checked')].map((x) => x.value);
        try {
          if (role) await api(`/api/roles/${role.id}/permissions`, { method: 'PUT', body: { permissions: perms, requires_mfa: mfa.checked } });
          else await api('/api/roles', { method: 'POST', body: { code: codeIn.value, name_en: nameIn.value, name_ar: nameAr.value, permissions: perms, requires_mfa: mfa.checked } });
          toast('Saved. Affected users get the change on their next request.'); d.close(); show('roles');
        } catch (e) { toast(errText(e), 'error'); }
      } }, t('Save'));
      d = modal(role ? nm(role.name_en, role.name_ar) : 'New custom role', h('div', {}, role ? null : h('div', { class: 'grid-form', style: { marginBottom: '12px' } }, codeIn, nameIn, nameAr),
        h('label', { class: 'row', style: { marginBottom: '12px' } }, mfa, 'Require two-factor authentication'), boxes), role?.code === 'school_super_admin' ? [] : [save]);
    };
    return h('div', {}, h('div', { class: 'toolbar' }, h('span', { class: 'hint' }, 'Deny by default. You can only grant permissions you hold yourself.'), h('span', { class: 'spacer' }), can('role.manage') ? h('button', { class: 'btn primary', onclick: () => editor(null) }, '+ Custom role') : null),
      h('div', { class: 'card table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ['Role', 'Code', t('Permissions'), t('Users'), 'MFA', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, roles.map((r) => h('tr', {}, h('td', {}, nm(r.name_en, r.name_ar), r.is_preset ? '' : badge('Custom', 'info')), h('td', { class: 'mono' }, r.code), h('td', { class: 'num' }, r.permissions.length), h('td', { class: 'num' }, r.user_count), h('td', {}, r.requires_mfa ? badge('Required', 'info') : ''),
          h('td', {}, can('role.manage') ? h('button', { class: 'btn sm', onclick: () => editor(r) }, r.code === 'school_super_admin' ? 'View' : t('Edit')) : null)))))));
  };
  const show = async (k) => body.replaceChildren(k === 'users' ? usersPanel() : await rolesPanel());
  const defs = [];
  if (can('user.manage')) defs.push(['users', t('Users')]);
  if (can('role.manage')) defs.push(['roles', t('Roles') + ' & ' + t('Permissions')]);
  root.replaceChildren(pageHead(t('Users & roles')), tabs(defs, show, defs[0][0]), body);
  show(defs[0][0]);
}

// ---------------- Settings ----------------
export async function settingsView(root) {
  const { tenant } = await api('/api/settings');
  let logo = tenant.logo_data;
  const preview = h('div', { class: 'brand', style: { background: 'var(--brand)', color: '#fff', borderRadius: '10px', padding: '12px' } });
  const renderPrev = () => preview.replaceChildren(logo ? h('img', { src: logo, alt: 'Logo preview' }) : h('div', { class: 'mono' }, tenant.code.slice(0, 2)), h('div', {}, h('b', {}, tenant.name_en), h('small', {}, 'Noviqtek School Management')));
  renderPrev();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const cur = tenant.working_days.split(',');
  const dayBoxes = h('div', { class: 'row' }, days.map((d, i) => h('label', { class: 'row' }, h('input', { type: 'checkbox', value: String(i), checked: cur.includes(String(i)) }), d)));
  const logoIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onchange: () => {
    const f = logoIn.files[0]; if (!f) return;
    if (f.size > 200 * 1024) { toast('Logo must be under 200 KB.', 'error'); logoIn.value = ''; return; }
    const r = new FileReader(); r.onload = () => { logo = r.result; renderPrev(); }; r.readAsDataURL(f);
  } });
  const f = form([
    { name: 'name_en', label: 'School name (English)', required: true }, { name: 'name_ar', label: 'School name (Arabic)', dir: 'rtl' },
    { name: 'primary_color', label: 'Primary colour', type: 'color' }, { name: 'accent_color', label: 'Accent colour', type: 'color' },
    { name: 'phone', label: t('Phone') }, { name: 'email', label: t('Email'), type: 'email' }, { name: 'address', label: 'Address', wide: true },
  ], tenant, {
    onSubmit: async (v) => {
      const working_days = [...dayBoxes.querySelectorAll('input:checked')].map((x) => x.value).join(',');
      await api('/api/settings', { method: 'PUT', body: { ...v, working_days, logo_data: logo, version: tenant.version } });
      toast('Settings saved.'); window.dispatchEvent(new Event('nq:refresh-me'));
    },
  });
  f.el.querySelector('.grid-form').append(
    h('div', { class: 'field', style: { gridColumn: '1 / -1' } }, h('span', {}, 'Working days (school week)'), dayBoxes, h('span', { class: 'hint' }, 'Default Sunday–Thursday.')),
    h('label', { class: 'field' }, 'Logo (PNG/JPEG/WebP, under 200 KB)', logoIn), h('div', {}, h('button', { class: 'btn sm', type: 'button', onclick: () => { logo = null; renderPrev(); } }, 'Remove logo')), h('div', { style: { gridColumn: '1 / -1' } }, preview));
  root.replaceChildren(pageHead(t('School settings')),
    h('div', { class: 'card card-pad' }, h('p', { class: 'muted' }, `Code ${tenant.code} · Timezone ${tenant.timezone} · Currency ${tenant.currency} · Country ${tenant.country}`), f.el));
}

// ---------------- Audit ----------------
export async function auditView(root) {
  const st = { action: '' };
  const table = dataTable({ id: 'audit', pageSize: 50, columns: [
    { key: 'at', label: 'Time', render: (r) => fmtDate(r.at) }, { key: 'actor', label: 'Actor' }, { key: 'action', label: 'Action', render: (r) => h('span', { class: 'mono' }, r.action) },
    { key: 'entity', label: 'Record', render: (r) => r.entity ? `${r.entity}${r.entity_id ? ' · ' + r.entity_id.slice(0, 10) : ''}` : '' }, { key: 'reason', label: t('Reason') },
    { key: 'details', label: 'Details', hidden: true, render: (r) => h('span', { class: 'hint mono' }, (r.details || '').slice(0, 160)) },
    { key: 'verified', label: 'Integrity', render: (r) => r.verified ? badge('Signed', 'ok') : badge('MISMATCH', 'bad') }, { key: 'correlation_id', label: 'Ref', hidden: true }],
    fetchPage: ({ page, size }) => api(`/api/audit?page=${page}&size=${size}&action=${encodeURIComponent(st.action)}`) });
  root.replaceChildren(pageHead(t('Audit log')), h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: 'Filter by action prefix, e.g. student. or auth.', 'aria-label': 'Action', oninput: debounce((e) => { st.action = e.target.value; table.reload(true); }) })), table.el);
  table.reload();
}

// ---------------- Parent portal ----------------
export async function portalView(root) {
  const d = await api('/api/portal/children');
  root.replaceChildren(pageHead(t('My children'), h('span', { class: 'muted' }, fmtDate(d.date))),
    d.children.length ? h('div', { class: 'dgrid' }, d.children.map((c) => h('div', { class: 'card dcard' }, h('div', { class: 'who' }, nm(c.official_name_en, c.official_name_ar)), h('div', { class: 'hint' }, `${t('Class')}: ${c.class_code || '—'}`),
      h('div', { class: 'row' }, t('Attendance') + ':', statusBadge(c.attendance_today)), h('div', { class: 'row' }, t('Dismissal') + ':', c.dismissal_today ? statusBadge(c.dismissal_today) : badge(t('Not called'), 'muted'))))) :
      h('div', { class: 'empty card' }, 'No children are linked to your account with portal access. Please contact the school office.'));
}

// ---------------- Account & MFA ----------------
export async function accountView(root) {
  const f = form([{ name: 'current_password', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' }, { name: 'new_password', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 12 characters using three of: lowercase, uppercase, digits, symbols.' }], {}, {
    submitLabel: t('Change password'), onSubmit: async (v) => { await api('/api/password/change', { method: 'POST', body: v }); toast('Password changed. Other sessions were signed out.'); f.el.reset(); },
  });
  root.replaceChildren(pageHead(t('My account')), h('div', { style: { display: 'grid', gap: '16px' } },
    h('div', { class: 'card card-pad' }, h('h2', {}, state.me.user.display_name), h('p', {}, state.me.user.email), h('p', {}, t('Roles') + ': ', state.me.roles.map((r) => nm(r.name_en, r.name_ar)).join(', '))),
    h('div', { class: 'card card-pad' }, h('h2', {}, t('Two-factor authentication')), state.me.user.mfa_enabled ? badge('Enabled', 'ok') : h('a', { class: 'btn primary', href: '#/mfa' }, 'Set up')),
    h('div', { class: 'card card-pad' }, h('h2', {}, t('Change password')), f.el)));
}
export async function mfaView(root) {
  if (state.me.user.mfa_enabled) { location.hash = '#/'; return; }
  let s;
  try { s = await api('/api/mfa/setup', { method: 'POST' }); }
  catch (e) { if (e.status === 400) { location.hash = '#/'; return; } throw e; }
  const qrBox = h('div', { style: { background: '#fff', padding: '8px', width: 'max-content', borderRadius: '8px' } });
  try { await loadScript('/vendor/qrcode.js'); const qr = window.qrcode(0, 'M'); qr.addData(s.otpauth); qr.make(); qrBox.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2 }); }
  catch { qrBox.textContent = 'QR unavailable — enter the key manually.'; }
  const f = form([{ name: 'code', label: t('Authentication code'), required: true, inputmode: 'numeric', autocomplete: 'one-time-code', max: 6 }], {}, {
    submitLabel: 'Turn on',
    onSubmit: async (v) => { await api('/api/mfa/enable', { method: 'POST', body: { code: v.code } }); toast('Two-factor authentication is on.'); history.replaceState(null, '', '#/'); window.dispatchEvent(new Event('nq:refresh-me')); },
  });
  root.replaceChildren(pageHead(t('Two-factor authentication')), h('div', { class: 'card card-pad', style: { maxWidth: '560px' } },
    state.me.needs_mfa_enrollment ? h('div', { class: 'alert warn' }, 'Your role requires two-factor authentication before you can continue.') : null,
    h('ol', {}, h('li', {}, 'Open an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…).'), h('li', {}, 'Scan this QR code, or enter the key below.'), h('li', {}, 'Type the 6-digit code to confirm.')),
    qrBox, h('p', {}, 'Key: ', h('code', { class: 'mono', style: { wordBreak: 'break-all' } }, s.secret)), f.el));
}
