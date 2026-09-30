import { HttpError, bad, json, newId, nowIso, readJson, str } from '../lib/util.js';
import { audit, require } from '../lib/auth.js';
import { IMPORT_DEFS, SCHEMA_VERSION, publicDefs } from '../lib/import-defs.js';
import { buildCommitStatements, validateImport } from '../lib/importer.js';

// Extra permission needed per module on top of import.run.
const MODULE_PERMS = {
  campuses: ['tenant.configure'], academic_years: ['academic.manage'], terms: ['academic.manage'], timing_groups: ['academic.manage'],
  year_groups: ['academic.manage'], departments: ['staff.manage'], subjects: ['academic.manage'], staff: ['staff.manage'],
  classes: ['academic.manage'], teaching_assignments: ['staff.manage'], students: ['student.create', 'student.edit'],
  enrollments: ['student.edit'], families: ['family.manage'], guardians: ['family.manage'], student_guardians: ['family.manage'],
  attendance_history: ['attendance.correct'],
};

function rowReport(parsed, limit = 500) {
  const errors = parsed.filter((p) => p.action === 'error').slice(0, limit).map((p) => ({ row: p.row, errors: p.errors }));
  const changes = parsed.filter((p) => p.action === 'update').slice(0, 200).map((p) => ({ row: p.row, changes: p.changes }));
  const actions = parsed.map((p) => ({ row: p.row, action: p.action }));
  return { errors, changes, actions: actions.slice(0, 5000) };
}

export default [
  ['GET', '/api/imports/definitions', async ({ ctx }) => {
    require(ctx, 'import.run');
    return json({ schema_version: SCHEMA_VERSION, modules: publicDefs().map((d) => ({ ...d, allowed: (MODULE_PERMS[d.module] || []).every((p) => ctx.perms.has(p)) })) });
  }],

  ['POST', '/api/imports/validate', async ({ request, env, ctx }) => {
    require(ctx, 'import.run');
    const b = await readJson(request, 8_000_000);
    if (!IMPORT_DEFS[b.module]) throw bad('Unknown import module.');
    require(ctx, ...MODULE_PERMS[b.module]);
    if (b.schema_version && b.schema_version !== SCHEMA_VERSION) throw bad(`This template is schema version ${b.schema_version}; the current version is ${SCHEMA_VERSION}. Download a fresh template.`);
    const v = await validateImport(env, ctx.tenantId, b.module, b.rows, b.mode || 'upsert');
    const prior = await env.DB.prepare("SELECT id, committed_at FROM import_jobs WHERE tenant_id = ? AND module = ? AND file_hash = ? AND status = 'committed'").bind(ctx.tenantId, b.module, v.hash).first();
    return json({ summary: v.summary, file_hash: v.hash, already_committed: prior || null, ...rowReport(v.parsed) });
  }],

  ['POST', '/api/imports/commit', async ({ request, env, ctx }) => {
    require(ctx, 'import.run');
    const b = await readJson(request, 8_000_000);
    const def = IMPORT_DEFS[b.module];
    if (!def) throw bad('Unknown import module.');
    require(ctx, ...MODULE_PERMS[b.module]);
    const mode = b.mode || 'upsert';
    const v = await validateImport(env, ctx.tenantId, b.module, b.rows, mode);
    if (b.file_hash && b.file_hash !== v.hash) throw bad('The file changed since it was validated. Validate again.');
    // Idempotency: the same file content + mode can only be committed once.
    const prior = await env.DB.prepare("SELECT id, committed_at FROM import_jobs WHERE tenant_id = ? AND module = ? AND file_hash = ? AND status = 'committed'").bind(ctx.tenantId, b.module, v.hash).first();
    if (prior) throw new HttpError(409, 'ALREADY_COMMITTED', `This exact file was already imported (job ${prior.id} at ${prior.committed_at}). Nothing was changed.`, prior);
    if (v.summary.file_errors.length) throw bad(v.summary.file_errors.join(' '));
    if (v.summary.invalid) {
      if (!def.allowValidOnly) throw bad(`${v.summary.invalid} row(s) have errors. This module imports all-or-nothing; fix the errors and validate again.`);
      if (!b.valid_only) throw bad(`${v.summary.invalid} row(s) have errors. Fix them, or confirm importing valid rows only.`);
    }
    const clears = v.parsed.some((p) => p.action === 'update' && p.clears.length);
    if (clears && !b.confirm_clear) throw bad('Some cells use __CLEAR__ to empty existing values. Confirm clearing to continue.');
    const { stmts, count } = buildCommitStatements(env, ctx.tenantId, v);
    const jobId = newId('imp_');
    const now = nowIso();
    const s = v.summary;
    const result = rowReport(v.parsed, 1000);
    await env.DB.batch([
      ...stmts,
      env.DB.prepare(`INSERT INTO import_jobs (id, tenant_id, module, mode, file_name, file_hash, schema_version, status, total_rows, valid_rows, error_rows, created_count, updated_count, unchanged_count, result, created_by, created_at, committed_at)
        VALUES (?,?,?,?,?,?,?,'committed',?,?,?,?,?,?,?,?,?,?)`)
        .bind(jobId, ctx.tenantId, b.module, mode, str(b.file_name, { max: 200 }), v.hash, SCHEMA_VERSION, s.total, s.valid, s.invalid, s.creates, s.updates, s.unchanged, JSON.stringify({ errors: result.errors, actions: result.actions }).slice(0, 500_000), ctx.user.id, now, now),
      await audit(env, ctx, 'import.commit', 'import_job', jobId, { module: b.module, mode, file: b.file_name, created: s.creates, updated: s.updates, unchanged: s.unchanged, skipped_invalid: s.invalid, written: count }),
    ]);
    return json({ job_id: jobId, summary: s, ...result });
  }],

  ['GET', '/api/imports/jobs', async ({ env, ctx }) => {
    require(ctx, 'import.run');
    const rows = (await env.DB.prepare(
      `SELECT j.id, j.module, j.mode, j.file_name, j.status, j.total_rows, j.valid_rows, j.error_rows, j.created_count, j.updated_count, j.unchanged_count, j.committed_at, u.display_name AS by_name
       FROM import_jobs j LEFT JOIN users u ON u.id = j.created_by WHERE j.tenant_id = ? ORDER BY j.created_at DESC LIMIT 100`
    ).bind(ctx.tenantId).all()).results;
    return json({ rows });
  }],
  ['GET', '/api/imports/jobs/:id', async ({ env, ctx, params }) => {
    require(ctx, 'import.run');
    const j = await env.DB.prepare('SELECT * FROM import_jobs WHERE id = ? AND tenant_id = ?').bind(params.id, ctx.tenantId).first();
    if (!j) throw new HttpError(404, 'NOT_FOUND', 'Import job not found.');
    j.result = JSON.parse(j.result || '{}');
    return json({ job: j });
  }],
];
