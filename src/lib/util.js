// Shared helpers: IDs, time, hashing, HTTP responses, errors.
const enc = new TextEncoder();

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const bad = (msg, details) => new HttpError(400, 'VALIDATION_ERROR', msg, details);
export const forbidden = (msg = 'You do not have permission for this action.') => new HttpError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Record not found.') => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (msg, details) => new HttpError(409, 'CONFLICT', msg, details);

export function newId(prefix = '') {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return prefix + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const nowIso = () => new Date().toISOString();

// Local school date (YYYY-MM-DD) in the tenant timezone, default Asia/Qatar.
export function localDate(tz = 'Asia/Qatar', d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(text));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
};
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  });
}
export function errorResponse(err, correlationId) {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message, details: err.details, correlation_id: correlationId } }, err.status);
  }
  const msg = String(err && err.message || err);
  if (/UNIQUE constraint failed/i.test(msg)) {
    return json({ error: { code: 'DUPLICATE', message: 'A record with the same unique reference already exists.', correlation_id: correlationId } }, 409);
  }
  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    return json({ error: { code: 'REFERENCE_ERROR', message: 'A referenced record does not exist or is still in use.', correlation_id: correlationId } }, 409);
  }
  console.error(JSON.stringify({ level: 'error', correlation_id: correlationId, message: msg, stack: err && err.stack }));
  return json({ error: { code: 'INTERNAL', message: 'Unexpected server error. Quote the reference when reporting it.', correlation_id: correlationId } }, 500);
}

export async function readJson(request, maxBytes = 5_000_000) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) throw new HttpError(413, 'TOO_LARGE', 'Request body is too large.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'TOO_LARGE', 'Request body is too large.');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw bad('Request body must be valid JSON.'); }
}

// Validation helpers
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isValidDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
export function str(v, { max = 200, required = false, name = 'value' } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw bad(`${name} is required.`);
    return null;
  }
  const s = String(v).trim();
  if (s.length > max) throw bad(`${name} must be at most ${max} characters.`);
  return s;
}
export function dateField(v, { required = false, name = 'date' } = {}) {
  const s = str(v, { max: 10, required, name });
  if (s && !isValidDate(s)) throw bad(`${name} must be a valid date in YYYY-MM-DD format.`);
  return s;
}
export function code(v, { required = true, name = 'code', max = 40 } = {}) {
  const s = str(v, { max, required, name });
  if (s && !/^[A-Za-z0-9][A-Za-z0-9_.\-\/]*$/.test(s)) throw bad(`${name} may contain letters, digits, - _ . / only.`);
  return s;
}
export function emailField(v, { required = false, name = 'email' } = {}) {
  const s = str(v, { max: 254, required, name });
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad(`${name} is not a valid email address.`);
  return s ? s.toLowerCase() : null;
}
export function oneOf(v, allowed, { required = false, name = 'value' } = {}) {
  const s = str(v, { max: 60, required, name });
  if (s && !allowed.includes(s)) throw bad(`${name} must be one of: ${allowed.join(', ')}.`);
  return s;
}
export function intField(v, { min = 0, max = 1e9, name = 'number' } = {}) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number between ${min} and ${max}.`);
  return n;
}
export function paging(url) {
  const page = Math.max(1, Number(url.searchParams.get('page') || 1) | 0);
  const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size') || 25) | 0));
  return { page, size, offset: (page - 1) * size };
}
