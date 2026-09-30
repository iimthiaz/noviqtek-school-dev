# Operations runbook

## Environments
| Env | Worker | D1 database | Config (generated) |
|---|---|---|---|
| production | `noviqtek-school` | `noviqtek-school-production` | `wrangler.production.toml` |
| staging | `noviqtek-school-staging` | `noviqtek-school-staging` | `wrangler.staging.toml` |
| local | — | SQLite shim / `wrangler dev` | `wrangler.toml` |

Staging and production use separate databases, so demo data never touches production. Deploy to staging first: `npm run deploy:staging`.

## Release
1. Run `npm test`. All tests must pass.
2. Run `npm run deploy:staging` and walk through login, attendance, dismissal and one import.
3. Run `npm run deploy`. The script exports a pre-deploy backup to `backups/`, applies only pending migrations, deploys, and health-checks `/api/health`.

Migrations are forward-only. Write them to be backward compatible (add columns and tables; never drop them in the same release) so the previous Worker version still works after a rollback.

## Rollback
- **Code:** run `npx wrangler rollback --config wrangler.production.toml`. This restores the previous Worker version instantly.
- **Data:** use D1 Time Travel to restore to a point in time within the retention window:
  `npx wrangler d1 time-travel info noviqtek-school-production`
  `npx wrangler d1 time-travel restore noviqtek-school-production --timestamp <ISO time>`
  A restore replaces the live database, so first export the current state with `npm run backup`.

## Backup and restore drill (do this before go-live, then every term)
1. Run `npm run backup`. This writes `backups/noviqtek-school-production-<time>.sql`. Store it encrypted; it contains personal data.
2. Restore into staging:
   `npx wrangler d1 execute noviqtek-school-staging --remote --file backups/<file>.sql --config wrangler.staging.toml`
   Use an empty staging database: delete and recreate it, then deploy staging without applying migrations first.
3. Reconcile. Compare counts of students, enrollments, attendance and audit_log between production and staging, and record the result.

## Secrets
- `AUDIT_KEY` signs every audit row (HMAC). The deploy script generates it once. **Do not rotate it casually**: older rows would show as "MISMATCH". If it must be rotated, export the audit log first and record the rotation date.
- There are no other secrets and no default administrator. Access starts from the one-time setup link.

## Common problems
| Symptom | Fix |
|---|---|
| Setup link says expired or used | Run `npm run new-school` to issue a new link. |
| "Set up two-factor authentication to continue" | This is required for admin-type roles. If a phone is lost, another administrator uses **Users → Reset MFA** (a reason is recorded). |
| User locked out | The lock clears after 15 minutes, or an admin issues a **Reset link**. |
| QR scan does nothing | Check that the camera permission is allowed. Otherwise use a handheld scanner or type the code. Revoked cards show "revoked". |
| "Connection is stale" on the dismissal board | The device lost its connection. It resyncs automatically; use the manual register until it clears. |
| Error shows "ref c_…" | Search Cloudflare Workers logs (Observability) for that correlation ID. |
| Import refused as "already imported" | The same file content was already committed. Nothing was changed. |

## Continuity (outage)
Keep a printed class list and a paper dismissal sheet per class. When service returns, enter the paper records through the attendance register (past dates need a correction reason) and the dismissal board.
