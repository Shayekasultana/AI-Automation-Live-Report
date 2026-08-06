# DBL AI Automation — Live Report

A department- and user-wise tracker for AI automation work across DBL Group's
IT division. Records each automation, what manual process it replaced, who owns
it, and the time and money it saves — then rolls that up into KPIs, eleven
charts and per-user workspaces.

Single-page app. No build step, no framework, no npm install.

```
START.bat                  →  http://localhost:8080
```

## Layout

```
index.html            the entire application — UI, logic, styles, icons
backend/
  Code.gs             Google Apps Script web app: the API and data store
  appsscript.json     manifest — timezone, scopes, web app access
scripts/serve.js      zero-dependency static server for local use
docs/
  SETUP.md            deploy the Sheet backend and point the app at it
  API.md              endpoint and storage reference
  Password-Reset-Setup.md
archive/              the original single-file dashboard, kept verbatim
```

`index.html` is intentionally one file. It is opened directly by people who are
not developers, emailed around, and occasionally hosted from a network share —
splitting it into modules would cost more than the tidiness is worth here.

## Getting started

1. `START.bat` — the dashboard runs immediately against its built-in seed data.
2. To make it shared and persistent, follow [`docs/SETUP.md`](docs/SETUP.md):
   create a Sheet, paste in `backend/Code.gs`, deploy as a web app, and put the
   `/exec` URL into the `API` constant near the bottom of `index.html`.

## Roles

| Role | Sees | Can |
| --- | --- | --- |
| **Viewer** (default, signed out) | every automation, read-only | export, print |
| **Editor** (self-service signup) | only their own automations | create, edit, delete, export |
| **Admin** | as editor | plus user management if promoted |
| **Super Admin** (`shayeka`) | everything, plus per-user workspaces | all of the above, plus Manage Users, Access Log, Audit Logs |

New signups become editors with a private workspace, and must use a DBL company
email. Rows carry an `ownerId`; rows predating workspaces are treated as
belonging to the Super Admin so nothing is orphaned.

## Data model

One row per automation. Beyond the obvious fields, each row records the manual
work time it replaced, the automated work time, executions per month, and the
per-execution cost of each — from which hours saved, cost saved per run and
monthly savings are derived rather than typed in.

Costs are multi-currency (BDT default). Totals are **never summed across
currencies** — the money KPI reports the dominant currency and offers a
per-currency breakdown.

Deleting archives: `archived` is set to `true`, the row leaves the report, and
the backend explicitly preserves it on the next full save. Nothing is destroyed.

## Security — read this before deploying externally

**The access control is a UI-layer control, not a security boundary.**

The web app must accept anonymous requests, because visitors have no Google
sign-in. So anyone who knows the `/exec` URL can POST to it directly and read
or write data regardless of what role the interface shows them. Role checks,
workspace scoping and the read-only viewer mode all live in the browser, where
a determined user can bypass them with dev tools.

What that means in practice:

- Fine for an internal, trusted-network tracker — which is what this is.
- **Not** appropriate for confidential data, or for exposure to the open
  internet, without moving authentication server-side.

Related, and deliberate:

- Passwords are stored as `SHA-256(SALT + password)` with a shared constant
  salt. Better than plaintext; weaker than a per-user salt with a slow KDF.
- Audit logs are per-device (`localStorage`), not synced to the Sheet. They
  are exportable so nothing is lost, but they are not a tamper-proof trail.
- Visitor location is city-level, resolved from IP via geojs.io with ipapi.co
  as fallback. Not GPS — but it does mean each visitor's public IP is sent to a
  third party.
- Presence is heartbeat-based (8s), not a live socket. Status is derived from a
  timestamp, so a crashed tab correctly ages out to Offline.

## Working on it

Everything is in `index.html`, organised in labelled sections: design tokens →
data → render → roles → presence → audit → auth → editing → charts → sync.

- **New KPI card**: add an entry to `KPI_VIEWS` and a card in `render()`.
- **New field on an automation**: add it to the form, to `addTask()`, to the
  `edit()` switch, and append it to `TASK_COLS` in `Code.gs` — append only,
  never insert.
- **After changing `Code.gs`**: redeploy as a *new version* of the existing
  deployment, or the URL will change.

## License

Internal to DBL Group.
