# Readiness report: milestone 1 (Foundation + core daily operations)

Status as of 30 September 2026. **This is not the finished school management system.** It is milestone 1 of the six in the specification, delivered as working, persisted and tested software.

## Architecture decision
- **Runtime:** Cloudflare Workers, with the JavaScript API and static single-page UI in one Worker (Workers Static Assets).
- **Database:** Cloudflare D1 (SQLite), multi-tenant. Every school-owned row carries `tenant_id`, and the tenant always comes from the session, never from client input. All writes are atomic D1 batches, and imports use `json_each()` bulk upserts so they stay within D1's per-request query and bound-parameter limits.
- **Live updates:** 3-second polling with a stale-connection warning, which meets the "within 5 s" target without websockets. Durable Objects can replace this in a later milestone.
- **Why D1 fits now:** a school's operational data (thousands of students, a few hundred thousand attendance rows per year) is far below D1's per-database size limit. Single-writer semantics make uniqueness (dismissal, attendance, sequences) straightforward.
- **Revisit when:** a single tenant approaches the D1 size limit, very many schools share one database (then shard per school, or move to Postgres through Hyperdrive), or you need timetable optimisation or PDF rendering, which would run in Queues/Containers.
- **Check before production:** current limits and pricing in Cloudflare's documentation for D1 (database size, queries per invocation) and Workers (CPU time).

The free plan's query limit per request is much lower than the paid plan's, so **use Workers Paid for a live school**.

## Requirements matrix

| Area | Status | Evidence |
|---|---|---|
| Tenant/school setup via one-time link, or SETUP_KEY for the first school (one-click install); no default admin | Done | tests: setup, token reuse, setup key |
| Multi-school isolation (API, IDs, exports, imports, QR) | Done | test: school B isolation |
| Auth: PBKDF2 passwords, secure cookies, CSRF, origin check, rate limit, lockout | Done | tests: CSRF, lockout |
| Administrator MFA (TOTP) enforced by role | Done | test: MFA enrolment |
| Invite, reset links, disable (revokes sessions), MFA reset | Done | tests |
| 24 role presets, custom roles, deny-by-default, no privilege escalation | Done | tests: escalation, permission revoke |
| Class-scoped teacher access; parent sees only linked children | Done | tests |
| Audit log: HMAC-signed, append-only (DB triggers) | Done | test |
| English/Arabic UI, RTL, light/dark, density, column chooser | Done | screenshots |
| Qatar defaults: Asia/Qatar, QAR, Sun–Thu, ISO dates | Done | settings |
| Academic years, terms, timing groups, year groups (Y1A–6B sample), classes, subjects, departments, campuses | Done | CRUD with version checks |
| Students (immutable ID, editable admission no.), enrollments, capacity | Done | test: edit persists / stale rejected |
| Families, guardians, explicit links, pickup/portal flags, validity dates | Done | |
| Staff, teaching assignments | Done | |
| Import Center: 16 templates, XLSX (Instructions/Data/Dictionary/Lookups/Examples) + CSV + dictionary, validate → preview → commit, create/update/upsert, blank-keeps, `__CLEAR__`, formula-injection, duplicates, idempotent re-upload | Done | tests |
| Daily attendance (P/A/L/E), unmarked ≠ present, past corrections need reason, summary, CSV export | Done | test |
| Dismissal: reception call, family QR check-in (siblings across classes), teacher confirm, no duplicates, no re-call after dismissal, reopen with reason, revocable opaque QR, printable A4 cards, stale warning | Done | test |
| Parent portal (today's attendance and dismissal) | Done (basic) | test |
| Dashboards with metric definitions and scope | Done (core metrics) | |
| Import undo, photo/document bulk upload (R2) | Next | |
| Per-period attendance, absence notifications | Milestone 2 | |
| Timetable generation and substitution | Milestone 2 | |
| Teacher and parent communication, email/SMS/WhatsApp | Milestone 3 | |
| Learning, gradebook, report cards, events, certificates | Milestone 3 | |
| Fees and accounting, HR/payroll, transport, library, assets, tickets, procurement, visitors | Milestone 4 | |
| Learning support, behaviour, clinic, counselling, safeguarding | Milestone 5 | The permission catalog and roles are reserved, but the modules are not built. |
| Integrations (Google SSO/Classroom, payments, Snipe-IT), automation builder, analytics, PDF reports, subscription billing | Milestone 6 | |

## Test evidence
- `npm test`: **18/18 passing** (including the one-click SETUP_KEY bootstrap) against a D1-compatible SQLite database. Coverage includes tenant isolation, teacher scoping, permission revocation, MFA, CSRF, lockout, import validation, idempotency, attendance counting, dismissal concurrency, QR revocation, parent scoping, privilege escalation and audit integrity.
- A browser walkthrough (Chromium) covered setup, MFA, dashboard, import, student edit + reload, attendance save, QR check-in, the live board, English/Arabic, dark mode and 390 px mobile. It found no layout overflow.

## Not yet verified (be honest about these)
- **A real Cloudflare deployment.** The code, the CLI deploy script and the Deploy-button configuration were tested locally, but not against a live Cloudflare account. Install once on a test account first.
- **Printed QR card sizing.** Print one sheet and scan it with the gate device before issuing cards.
- **Load and performance.** No load test has been run yet.
- **Legal and compliance.** Qatar's Personal Data Privacy Protection Law (No. 13 of 2016) and NCSA guidance on special-nature data must be reviewed before real children's data is imported. D1 location hints are not a data-residency guarantee. Nothing here claims Ministry integration or compliance approval.
- **Official curriculum rules.** Arabic, Islamic Studies and Qatar History rules, and Ramadan and holiday dates, are configurable and must be confirmed against current MOEHE guidance by the school.

## Known limitations
- Fonts load from Google Fonts. Without them the UI falls back to system fonts.
- Imports are processed in-request (max 5,000 rows per file). Larger migrations should be split into several files.
- One email address maps to one school account.
- The dismissal session is a single afternoon "PM" session per day. Multiple sessions come in milestone 2.

## Outstanding decisions for the school or Noviqtek
1. Production domain.
2. Workers Paid plan.
3. D1 location hint.
4. Privacy review sign-off.
5. Who holds the super-administrator role (at least two people).
6. QR card print vendor or printer.
