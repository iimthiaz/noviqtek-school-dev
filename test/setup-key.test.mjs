// One-click install bootstrap: SETUP_KEY creates only the first school.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './d1-shim.mjs';
import { handleApi } from '../src/worker.js';

const env = { DB: createD1(new URL('../migrations', import.meta.url).pathname), AUDIT_KEY: 'k', SETUP_KEY: 'correct-setup-key-123' };
const call = async (path, body) => {
  const res = await handleApi(new Request('https://x.test' + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, data: await res.json() };
};
const school = (key, code, email) => ({ setup_key: key, school_code: code, name_en: 'Demo', admin_name: 'Admin', admin_email: email, password: 'Correct-Horse-9-Battery' });

test('setup key bootstraps exactly one first school', async () => {
  assert.equal((await call('/api/health')).data.setup_key_available, true);
  assert.equal((await call('/api/setup/check', { setup_key: 'wrong-key-xxxxxxx' })).data.error.code, 'BAD_SETUP_KEY');
  assert.equal((await call('/api/setup', school('wrong-key-xxxxxxx', 'A1', 'a@example.invalid'))).status, 400);
  assert.equal((await call('/api/setup/check', { setup_key: env.SETUP_KEY })).status, 200);
  const ok = await call('/api/setup', school(env.SETUP_KEY, 'A1', 'a@example.invalid'));
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const again = await call('/api/setup', school(env.SETUP_KEY, 'B1', 'b@example.invalid'));
  assert.equal(again.data.error.code, 'SETUP_KEY_UNAVAILABLE');
  assert.equal((await call('/api/health')).data.setup_key_available, false);
});

test('short or missing SETUP_KEY is never accepted', async () => {
  const e2 = { ...env, DB: createD1(new URL('../migrations', import.meta.url).pathname), SETUP_KEY: 'short' };
  const res = await handleApi(new Request('https://x.test/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(school('short', 'C1', 'c@example.invalid')) }), e2);
  assert.equal((await res.json()).error.code, 'SETUP_KEY_UNAVAILABLE');
});
