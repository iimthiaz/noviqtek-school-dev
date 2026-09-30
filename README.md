# Noviqtek School Management — Cloudflare edition

*Developed by Noviqtek.* This is milestone 1, the foundation: a working, deployable school platform on Cloudflare Workers + D1. It covers:

- Tenant setup
- Authentication with administrator MFA
- Roles and permissions
- Bilingual English/Arabic UI
- Audit log
- Academic master data
- Student, family and staff records
- The Data Import Center
- Daily attendance
- Smart dismissal with family QR cards
- A parent portal

See `docs/READINESS.md` for what is complete and what is still to come.

## One-click install (Deploy to Cloudflare)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR-GITHUB-ACCOUNT/noviqtek-school)

**Make the link yours once.** Upload this folder to a **public** GitHub repository, for example `noviqtek-school`. Then replace `YOUR-GITHUB-ACCOUNT` in the button link above with your account name. Your install link is:

```
https://deploy.workers.cloudflare.com/?url=https://github.com/<your-account>/noviqtek-school
```

**What happens when someone opens the link:**
1. They sign in to Cloudflare and connect GitHub. Cloudflare copies the repository into their account.
2. Cloudflare creates the D1 database automatically.
3. They enter two secrets:
   - `AUDIT_KEY`: a long random value, 32+ characters. Never change it later.
   - `SETUP_KEY`: a private key, 12+ characters, used once to create the first school.
4. Cloudflare builds and deploys. The deploy script bundles the QR/Excel libraries, applies the database migrations, and deploys the Worker.
5. They open `https://<app>.workers.dev/#/setup`, enter the `SETUP_KEY`, create the school and first administrator, and set up two-factor sign-in.

The setup key only works while no school exists. After the first school, it is useless.

## Command-line deploy (alternative)

**Prerequisites:** Node.js 20+ and a Cloudflare account.

```bash
npm install
npm run deploy:cli     # creates DB, migrates, deploys, prints a one-time setup link
```

| Task | Command |
|---|---|
| Custom domain | `node scripts/deploy.mjs --domain portal.yourschool.qa` |
| Staging copy | `npm run deploy:staging` |
| Add another school (tenant) | `npm run new-school` |
| Backup now | `npm run backup` |
| Roll back the last release | `npx wrangler rollback --config wrangler.production.toml` |
| Check without deploying | `node scripts/deploy.mjs --dry-run` |

Use the Workers Paid plan for a live school; see `docs/READINESS.md`.

## After setup

1. **Academic setup:** confirm the academic-year dates. The sample year is labelled "(confirm dates)".
2. **School settings:** set the Arabic name, logo, colours and working days (Sunday–Thursday by default).
3. **Import Center:** download each template (`.xlsx` or CSV plus the field dictionary), fill it in and upload it. Validate first, then commit. Work in the listed order.
4. **Users & roles:** invite staff and link each account to its staff record, so teachers see only their own classes. Invite parents linked to their guardian record.
5. **Families:** print the QR cards (A4, 85×54 mm). Gate staff can scan them with a phone camera, a handheld scanner, or by typing the code.

## Develop and test

```bash
npm test                         # 18 integration/security tests (Node 22.5+, no Cloudflare needed)
node test/dev-server.mjs 8787    # local server on a D1-compatible SQLite shim; prints a setup link
npx wrangler dev                 # real Workers runtime locally (copy .dev.vars.example to .dev.vars)
```

## Layout

```
migrations/        D1 schema (SQL migrations)
src/worker.js      API router, security checks, scheduled cleanup
src/lib/           auth (PBKDF2, TOTP, sessions), permissions, import engine, CSV
src/routes/        auth, admin, students, attendance, dismissal, imports, dashboard, generic CRUD
public/            bilingual single-page app (no build step), _headers (CSP)
scripts/deploy.mjs one-command deployment
test/              D1 shim, API tests, dev server
docs/              RUNBOOK.md, READINESS.md
```
