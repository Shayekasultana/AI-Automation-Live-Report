# Google Workspace Sign-In — setup

End-to-end instructions for turning on **Continue with Google Workspace**.
Budget about 20 minutes. You need admin access to a Google Cloud project and
edit access to the Apps Script behind this dashboard.

Until this is configured the button explains that in plain language and the
email-and-password form keeps working. Nothing breaks in the meantime.

---

## How it works

```
Browser                          Apps Script (Code.gs)              Google
   │                                     │                             │
   │ 1. user clicks the button           │                             │
   │────────── Google Identity Services ─┼────────────────────────────▶│
   │◀───────── ID token (JWT) ───────────┼─────────────────────────────│
   │                                     │                             │
   │ 2. POST {type:'googleAuth', credential}                           │
   │────────────────────────────────────▶│                             │
   │                                     │ 3. verify token with Google │
   │                                     │────────────────────────────▶│
   │                                     │◀─── claims ─────────────────│
   │                                     │ 4. check aud / iss / exp /  │
   │                                     │    email_verified / hd      │
   │                                     │ 5. create or link account   │
   │◀── session token + refresh token ───│                             │
```

**The browser never decides whether a sign-in is valid.** It only carries the
token. Every check that matters happens in step 3–4, server-side, where a user
with dev tools cannot reach it.

---

## 1. Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Project dropdown (top bar) → **New Project**.
3. Name it something like `DBL AI Automation`. If you have a Workspace
   organisation, pick it under **Location** so the project belongs to the org
   rather than a personal account.
4. **Create**, then make sure the new project is selected.

## 2. OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. **User type**:
   - **Internal** — only your Workspace can sign in. Choose this. It needs no
     Google verification review and is exactly the restriction you want.
   - *External* — only if you must admit accounts outside the organisation.
     It requires a verification review before general use.
3. Fill in:
   - App name: `DBL AI Automation Live Report`
   - User support email: your IT address
   - App logo: optional
   - Authorised domains: `dbl-group.com` (plus any other domain you use)
   - Developer contact email: your IT address
4. **Scopes** — add nothing. Sign-in only needs the default `openid`,
   `email` and `profile`, which are implicit. Do not request more; extra
   scopes trigger a review and alarm users at the consent prompt.
5. Save.

## 3. OAuth Client ID

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Name: `DBL AI Automation — Web`.
4. **Authorised JavaScript origins** — the origin the page is served from, with
   no path and no trailing slash:

   | Where you run it | Origin |
   | --- | --- |
   | Local development | `http://localhost:8080` |
   | Internal server | `https://dashboards.dbl-group.com` |
   | GitHub Pages etc. | `https://yourorg.github.io` |

   Add every origin you will actually use. A mismatch here is the single most
   common cause of the button silently refusing to open.

5. **Authorised redirect URIs** — leave empty.

   Google Identity Services in popup mode returns the token to JavaScript and
   never performs a redirect, so no redirect URI is involved. Add one only if
   you later switch to `ux_mode: 'redirect'`.

6. **Create**, then copy the **Client ID**. It looks like
   `000000000000-abc123def456.apps.googleusercontent.com`.

   The Client ID is a public identifier and is safe in page source. The
   **client secret is not used** by this flow — ignore it, and never put it in
   the front end.

## 4. Tell the backend

The domain rules are enforced in `Code.gs`, so they have to be set there.

**The easy way:** in the dashboard go to **Settings → Google Workspace**, fill
in the Client ID and domains, then click **Copy backend setup command**. It
gives you a filled-in line like:

```js
configureGoogleAuth("000000-abc.apps.googleusercontent.com",
                    "dbl-group.com,dbl-pharma.com,dblceramics.com",
                    "");
```

Open your Sheet → **Extensions → Apps Script**, paste it at the bottom of the
editor, choose `configureGoogleAuth` in the function dropdown, and press
**Run**. Approve the permission prompt.

**Or by hand:** Apps Script → **Project Settings → Script Properties**:

| Property | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | your Client ID |
| `ALLOWED_DOMAINS` | `dbl-group.com,dbl-pharma.com,dblceramics.com` |
| `EMAIL_ALLOWLIST` | individual exceptions, or blank |

Then run `setup()` once so the `Sessions` sheet and the signing key exist.

> **Fail-closed:** if `ALLOWED_DOMAINS` is empty, *every* Google sign-in is
> refused. That is deliberate — a blank list must never mean "allow anyone".

## 5. Redeploy and test

Apps Script serves the **deployed** version, not the saved one:

**Deploy → Manage deployments → pencil icon → Version: New version → Deploy**

Then in the dashboard: **Settings → Google Workspace → Test Connection**. It
checks four things and shows a tick or cross for each:

- Client ID configured
- Backend knows the domains
- Google Identity Services reachable
- Page served over HTTPS (or `localhost`)

## 6. Sign in

Open the sign-in dialog. **Continue with Google Workspace** is now live.

---

## Domain restriction

Three layers, checked in this order:

1. **Individual allowlist** (`EMAIL_ALLOWLIST`) — a specific address always
   gets in. This is how a Super Admin admits one consultant on a personal
   Gmail without opening the door to all of Gmail.
2. **Hosted domain** — Google's `hd` claim, which reflects the Workspace the
   account actually belongs to. Preferred over the email address because a
   user cannot change it by editing their profile.
3. **Email domain** — falls back to the part after `@`.

Anything not matching is refused with a clear message naming the address.
Personal Gmail accounts have no `hd` claim and so are always refused unless
explicitly allowlisted.

## Roles

New Google users are always created as **Viewer**. Nobody self-promotes.

| Role | Sees | Can |
| --- | --- | --- |
| Viewer | all automations, read-only | export, print |
| Editor | only their own | create, edit, delete |
| Department Admin | their whole department | create, edit, delete within it |
| Admin | as editor | plus user management |
| Super Admin (`shayeka`) | everything | everything, all workspaces |

Promote from **Settings → Users**. The role is stored in the `Users` sheet and
re-read on every token refresh, so a change reaches an open tab within the hour
without anyone signing out.

## Sessions

| Piece | Detail |
| --- | --- |
| Access token | signed HMAC-SHA256, 1 hour, issued by `Code.gs` |
| Refresh token | random, 30 days with Remember Me, 12 hours without |
| Auto-login | a valid stored session restores before first paint |
| Auto-refresh | one minute before expiry, silently |
| Session timeout | separate idle logout, Settings → Security |
| Multi-device | every device is its own row in `Sessions`; view them under Settings → Google Workspace |
| Secure logout | revokes server-side, clears local state, and calls `disableAutoSelect()` so the next sign-in is deliberate |

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Button says "not configured" | `GOOGLE_CLIENT_ID` is not set on the backend, or the deployment was not updated to a new version |
| "not listed as an authorised JavaScript origin" | The origin in step 3 does not exactly match the address bar. Check `http` vs `https`, the port, and the absence of a trailing slash |
| Account chooser never appears | Third-party cookies blocked, or an ad blocker is blocking `accounts.google.com`. The message says so and the email form still works |
| "issued for a different application" | The Client ID in the page and the one on the backend are different |
| "not on an approved company domain" | Add the domain to `ALLOWED_DOMAINS`, or the address to `EMAIL_ALLOWLIST` |
| Works on localhost, not in production | The production origin was never added in step 3, or the site is not on HTTPS |

## Security notes — read before relying on this

**What this genuinely secures:** identity. A Google sign-in is verified by
Google, checked against your domain, and turned into a signed session token
that the browser cannot forge.

**What it does not yet secure:** the data endpoints. `doPost` still accepts
anonymous `tasks` writes, because that is how the dashboard has always worked.
Someone with the `/exec` URL can still write data without signing in at all.

Closing that gap means requiring a valid access token on the `tasks` and
`users` routes and rejecting requests without one. The verification helper is
already there — `verifyToken()` in `Code.gs` — so it is a contained change,
but it will lock out any tab that has not signed in. Decide deliberately, then
do it in one go.

Related, unchanged from before: passwords for non-Google accounts are stored as
`SHA-256(SALT + password)` with a shared salt, and audit logs remain per-device.
