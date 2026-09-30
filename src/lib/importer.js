// Generic, definition-driven import engine: validate → preview → commit.
// Commits use a single json_each() upsert per chunk inside one D1 batch, so an
// import is atomic and stays within D1's per-invocation query limits.
import { IMPORT_DEFS, SCHEMA_VERSION } from './import-defs.js';
import { bad, isValidDate, newId, nowIso, sha256Hex } from './util.js';

export const MAX_ROWS = 5000;
const CLEAR = '__CLEAR__';
const FORMULA = /^[=+\-@\t\r]/;

const LOOKUPS = {
  campus: ['campuses', 'code'], ay: ['academic_years', 'code'], tg: ['timing_groups', 'code'],
  yg: ['year_groups', 'code'], dept: ['departments', 'code'], subject: ['subjects', 'code'],
  staff: ['staff', 'staff_code'], student: ['students', 'admission_no'], guardian: ['guardians', 'guardian_code'],
  family: ['families', 'family_code'],
};

async function loadLookups(env, tenantId, def) {
  const kinds = new Set(def.fields.filter((x) => x.ref).map((x) => x.ref));
  const L = {};
  for (const k of kinds) {
    if (k === 'class') {
      const rows = (await env.DB.prepare('SELECT id, academic_year_id, code, campus_id FROM classes WHERE tenant_id = ?').bind(tenantId).all()).results;
      L.class = new Map(rows.map((r) => [`${r.academic_year_id}|${r.code}`, r]));
      continue;
    }
    const [table, col] = LOOKUPS[k];
    const rows = (await env.DB.prepare(`SELECT id, ${col} AS k FROM ${table} WHERE tenant_id = ?`).bind(tenantId).all()).results;
    L[k] = new Map(rows.map((r) => [String(r.k), r.id]));
  }
  if (def.derive === 'attendance_class') {
    const rows = (await env.DB.prepare(
      `SELECT student_id, class_id, start_date, end_date FROM enrollments WHERE tenant_id = ? AND enrollment_status IN ('active','ended','transferred')`
    ).bind(tenantId).all()).results;
    L.enroll = rows;
  }
  return L;
}

function convert(field, raw) {
  const v = raw;
  switch (field.type) {
    case 'text':
      if (v.length > field.max) return { err: `longer than ${field.max} characters` };
      if (FORMULA.test(v)) return { err: 'begins with a formula character (= + - @); remove it or prefix with an apostrophe in your editor' };
      return { v };
    case 'code':
      if (v.length > (field.max || 40)) return { err: `longer than ${field.max || 40} characters` };
      if (!/^[A-Za-z0-9][A-Za-z0-9_.\-\/]*$/.test(v)) return { err: 'may contain only letters, digits, - _ . /' };
      return { v };
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || v.length > 254) return { err: 'is not a valid email address' };
      return { v: v.toLowerCase() };
    case 'phone':
      if (!/^\+?[0-9 ()\-]{5,24}$/.test(v)) return { err: 'is not a valid phone number (digits, spaces, optional leading +)' };
      return { v };
    case 'date':
      if (!isValidDate(v)) return { err: 'must be a real date in YYYY-MM-DD format' };
      return { v };
    case 'time':
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return { err: 'must be HH:MM (24-hour)' };
      return { v };
    case 'int': {
      if (!/^\d{1,9}$/.test(v)) return { err: 'must be a whole number' };
      return { v: Number(v) };
    }
    case 'bool': {
      const s = v.toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(s)) return { v: 1 };
      if (['false', 'no', 'n', '0'].includes(s)) return { v: 0 };
      return { err: 'must be true or false' };
    }
    case 'enum':
      if (!field.values.includes(v)) return { err: `must be one of: ${field.values.join(', ')}` };
      return { v };
    default:
      return { v };
  }
}

export async function validateImport(env, tenantId, module, inputRows, mode) {
  const def = IMPORT_DEFS[module];
  if (!def) throw bad('Unknown import module.');
  if (!['create', 'update', 'upsert'].includes(mode)) throw bad('mode must be create, update or upsert.');
  if (!Array.isArray(inputRows)) throw bad('rows must be an array.');
  if (inputRows.length > MAX_ROWS) throw bad(`A single import is limited to ${MAX_ROWS} rows. Split the file.`);

  const fileErrors = [];
  const known = new Set(def.fields.map((x) => x.key));
  const headers = new Set();
  for (const r of inputRows.slice(0, 50)) for (const k of Object.keys(r || {})) headers.add(k);
  const unknown = [...headers].filter((h) => !known.has(h));
  if (headers.has('school_id') || headers.has('tenant_id')) fileErrors.push('Columns school_id / tenant_id are not accepted. The school is taken from your signed-in session.');
  const missingReq = def.fields.filter((x) => x.required && !headers.has(x.key)).map((x) => x.key);
  if (inputRows.length && missingReq.length) fileErrors.push(`Missing required columns: ${missingReq.join(', ')}`);

  const L = await loadLookups(env, tenantId, def);
  const parsed = [];
  const seen = new Map();

  inputRows.forEach((rawRow, i) => {
    const rowNo = i + 2; // header is row 1 in the spreadsheet
    const errors = [];
    const values = {};
    const clears = [];
    const meta = {};
    const src = {};
    for (const [k, v] of Object.entries(rawRow || {})) src[k] = v === null || v === undefined ? '' : String(v).trim();
    if (Object.values(src).every((v) => v === '')) return; // blank row
    for (const field of def.fields) {
      const raw = src[field.key] ?? '';
      if (raw === '') { if (field.required) errors.push({ column: field.key, message: 'is required' }); continue; }
      if (raw === CLEAR) {
        if (field.required) errors.push({ column: field.key, message: 'is required and cannot be cleared' });
        else clears.push(field.col);
        continue;
      }
      const c = convert(field, raw);
      if (c.err) { errors.push({ column: field.key, message: c.err, value: raw.slice(0, 60) }); continue; }
      if (field.ref) {
        let id;
        if (field.ref === 'class') {
          const hit = L.class.get(`${values.academic_year_id}|${c.v}`);
          id = hit && hit.id;
          if (hit) meta.classCampus = hit.campus_id;
        } else id = L[field.ref].get(String(c.v));
        if (!id) { errors.push({ column: field.key, message: `reference "${raw}" was not found in this school`, value: raw }); continue; }
        values[field.col] = id;
      } else values[field.col] = c.v;
    }
    if (def.derive === 'attendance_class' && values.student_id && values.attendance_date) {
      const e = L.enroll.find((x) => x.student_id === values.student_id && x.start_date <= values.attendance_date && (!x.end_date || x.end_date >= values.attendance_date));
      if (!e) errors.push({ column: 'attendance_date', message: 'student was not enrolled on this date' });
      else values.class_id = e.class_id;
    }
    if (!errors.length && def.validate) {
      const msg = def.validate(values, src, meta);
      if (msg) errors.push({ column: '', message: msg });
    }
    const keyVals = def.key.map((k) => values[k]);
    const keyStr = keyVals.every((x) => x !== undefined && x !== null) ? JSON.stringify(keyVals) : null;
    if (keyStr && seen.has(keyStr)) errors.push({ column: def.fields.find((x) => def.key.includes(x.col))?.key || '', message: `duplicate of row ${seen.get(keyStr)} in this file` });
    else if (keyStr) seen.set(keyStr, rowNo);
    parsed.push({ row: rowNo, values, clears, keyVals, keyStr, errors });
  });

  // Look up existing records by natural key in one query.
  const keyed = parsed.filter((p) => p.keyStr);
  const existing = new Map();
  for (let i = 0; i < keyed.length; i += 1000) {
    const chunk = keyed.slice(i, i + 1000).map((p) => p.keyVals);
    const on = def.key.map((k, idx) => `t.${k} = json_extract(j.value, '$[${idx}]')`).join(' AND ');
    const rows = (await env.DB.prepare(`SELECT t.* FROM ${def.table} t JOIN json_each(?2) j ON t.tenant_id = ?1 AND ${on}`)
      .bind(tenantId, JSON.stringify(chunk)).all()).results;
    for (const r of rows) existing.set(JSON.stringify(def.key.map((k) => r[k])), r);
  }

  let creates = 0, updates = 0, unchanged = 0, invalid = 0;
  for (const p of parsed) {
    const ex = p.keyStr ? existing.get(p.keyStr) : null;
    if (!p.errors.length) {
      if (ex && mode === 'create') p.errors.push({ column: '', message: 'record already exists (create-only mode)' });
      if (!ex && mode === 'update') p.errors.push({ column: '', message: 'record does not exist (update-only mode)' });
    }
    if (p.errors.length) { p.action = 'error'; invalid++; continue; }
    if (!ex) { p.action = 'create'; creates++; continue; }
    p.existing = ex;
    p.changes = {};
    for (const [col, v] of Object.entries(p.values)) if (ex[col] !== v && !(ex[col] == null && v == null)) p.changes[col] = { from: ex[col], to: v };
    for (const col of p.clears) if (ex[col] !== null) p.changes[col] = { from: ex[col], to: null };
    if (Object.keys(p.changes).length) { p.action = 'update'; updates++; } else { p.action = 'unchanged'; unchanged++; }
  }
  const hash = await sha256Hex(JSON.stringify({ module, mode, schema: SCHEMA_VERSION, rows: inputRows }));
  return {
    def, parsed, hash,
    summary: { total: parsed.length, valid: parsed.length - invalid, invalid, creates, updates, unchanged, file_errors: fileErrors, unknown_columns: unknown },
  };
}

export function buildCommitStatements(env, tenantId, v) {
  const { def, parsed } = v;
  const now = nowIso();
  const dataCols = [...new Set([...def.fields.map((x) => x.col), ...(def.derive === 'attendance_class' ? ['class_id'] : [])])];
  const extra = def.table === 'attendance' ? ['recorded_at'] : [];
  // Defaults for new records when an optional column is left blank (NOT NULL columns such as status).
  const defaults = Object.fromEntries(def.fields.map((x) => [x.col, x.default !== undefined ? x.default : x.type === 'bool' ? 0 : null]));
  const rows = [];
  for (const p of parsed) {
    if (p.action !== 'create' && p.action !== 'update') continue;
    const base = p.existing ? { ...p.existing } : { id: newId(), tenant_id: tenantId, created_at: now };
    const out = { id: base.id, tenant_id: tenantId, created_at: base.created_at, updated_at: now };
    for (const c of dataCols) out[c] = p.values[c] !== undefined ? p.values[c] : (p.clears.includes(c) ? null : (p.existing ? (base[c] ?? null) : (defaults[c] ?? null)));
    if (extra.includes('recorded_at')) out.recorded_at = base.recorded_at || now;
    rows.push(out);
  }
  const cols = ['id', 'tenant_id', ...dataCols, ...extra, 'created_at', 'updated_at'];
  const stmts = [];
  // Chunk by serialized size to keep each bound parameter well below D1 limits.
  let chunk = [], size = 0;
  const flush = () => {
    if (!chunk.length) return;
    const sql = `INSERT INTO ${def.table} (${cols.join(', ')})
      SELECT ${cols.map((c) => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?1) WHERE true
      ON CONFLICT (tenant_id, ${def.key.join(', ')}) DO UPDATE SET
      ${dataCols.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at, version = ${def.table}.version + 1`;
    stmts.push(env.DB.prepare(sql).bind(JSON.stringify(chunk)));
    chunk = []; size = 0;
  };
  for (const r of rows) {
    const s = JSON.stringify(r).length;
    if (size + s > 700_000) flush();
    chunk.push(r); size += s;
  }
  flush();
  if (def.table === 'academic_years') {
    const cur = rows.filter((r) => r.is_current === 1).pop();
    if (cur) stmts.push(env.DB.prepare('UPDATE academic_years SET is_current = CASE WHEN code = ?2 THEN 1 ELSE 0 END WHERE tenant_id = ?1').bind(tenantId, cur.code));
  }
  return { stmts, count: rows.length };
}
