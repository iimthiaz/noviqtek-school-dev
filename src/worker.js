// Noviqtek School Management — Cloudflare Worker entry point.
// Static UI is served from ./public by Workers Static Assets; /api/* runs here.
import { HttpError, errorResponse, json, newId } from './lib/util.js';
import { loadContext } from './lib/auth.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import crudRoutes from './routes/crud.js';
import studentRoutes from './routes/students.js';
import attendanceRoutes from './routes/attendance.js';
import dismissalRoutes from './routes/dismissal.js';
import importRoutes from './routes/imports.js';
import dashboardRoutes from './routes/dashboard.js';

const ROUTES = [...authRoutes, ...adminRoutes, ...studentRoutes, ...attendanceRoutes, ...dismissalRoutes, ...importRoutes, ...dashboardRoutes, ...crudRoutes]
  .map(([method, path, handler, opts = {}]) => ({
    method, handler, opts,
    re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'),
  }));

// Paths reachable while an administrator still has to enrol in MFA.
const MFA_ENROLL_ALLOWED = new Set(['/api/me', '/api/mfa/setup', '/api/mfa/enable', '/api/logout']);

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const correlationId = request.headers.get('x-correlation-id')?.slice(0, 64) || newId('c_');
  try {
    const route = ROUTES.find((r) => r.method === request.method && r.re.test(url.pathname));
    if (!route) throw new HttpError(404, 'NOT_FOUND', 'Unknown API endpoint.');
    const params = url.pathname.match(route.re).groups || {};
    const ctx = route.opts.public ? null : await loadContext(env, request);
    if (!route.opts.public && !ctx) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.');
    if (ctx) {
      ctx.ip = request.headers.get('cf-connecting-ip') || '';
      ctx.correlationId = correlationId;
      if (request.method !== 'GET') {
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) throw new HttpError(403, 'BAD_ORIGIN', 'Cross-site request blocked.');
        if (request.headers.get('x-csrf-token') !== ctx.csrf) throw new HttpError(403, 'CSRF', 'Session check failed. Reload the page and try again.');
      }
      if (ctx.needsMfaEnrollment && !MFA_ENROLL_ALLOWED.has(url.pathname)) {
        throw new HttpError(403, 'MFA_ENROLL_REQUIRED', 'Set up two-factor authentication to continue.');
      }
    }
    const res = await route.handler({ request, env, url, params, ctx, correlationId });
    res.headers.set('X-Correlation-Id', correlationId);
    return res;
  } catch (err) {
    return errorResponse(err, correlationId);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
  // Daily housekeeping (configured in wrangler.toml [triggers]).
  async scheduled(_event, env) {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').bind(now),
      env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Math.floor(Date.now() / 1000) - 86400),
      env.DB.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").bind(new Date(Date.now() - 3 * 86400e3).toISOString()),
    ]);
  },
};
export { json };
