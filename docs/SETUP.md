# Setup

Two parts: the dashboard (a single HTML file, no build step) and the Google
Apps Script backend that stores the data.

## 1. Run the dashboard

```bat
START.bat
```

or, equivalently:

```bash
node scripts/serve.js 8080
```

Then open <http://localhost:8080>. Serve it over `http://` rather than opening
`index.html` from the filesystem — the app uses `fetch`, `localStorage` and
`sessionStorage`, which browsers treat differently on a `file://` origin.

The dashboard works with no backend at all: it falls back to seed data held in
the page and to `localStorage`. Everything below is what makes it shared and
persistent across people and devices.

## 2. Create the Sheet and deploy the backend

1. Create a new Google Sheet. Name it something like
   `DBL AI Automation — Live Data`.
2. **Extensions → Apps Script**. This creates a script bound to that Sheet.
3. Delete the placeholder `Code.gs` contents and paste in all of
   [`backend/Code.gs`](../backend/Code.gs).
4. Optional but recommended — click the gear (**Project Settings**), tick
   *Show `appsscript.json`*, and replace it with
   [`backend/appsscript.json`](../backend/appsscript.json). This pins the
   timezone and requests only the two scopes the script actually needs.
5. In the editor, select the `setup` function from the dropdown and **Run** it
   once. It creates all six sheets with their header rows. Approve the
   permission prompt when Google asks.
6. **Deploy → New deployment → Web app**:
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
7. Copy the resulting `/exec` URL.

### Why "Anyone"

The dashboard calls the backend from the visitor's browser with no Google
sign-in, so the deployment has to accept anonymous requests. *Execute as: Me*
means the script still runs under your account, and only ever touches its own
bound Sheet. See the security note in [`../README.md`](../README.md) — this is
the deliberate trade-off the whole design rests on.

## 3. Point the dashboard at your deployment

In `index.html`, find:

```js
const API = "https://script.google.com/macros/s/…/exec";
```

Replace that URL with the one from step 7. Reload the page — the header pill
should change from *Connecting to Google Sheet…* to *Synced with Google Sheet
at …*.

## 4. Optional: reset emails

Set a script property so reset emails can contain a working link:

**Apps Script → Project Settings → Script Properties → Add property**

| Property  | Value                                    |
| --------- | ---------------------------------------- |
| `APP_URL` | the URL where you host `index.html`      |

Without it the email still sends, but carries the raw token instead of a
one-click link. Full detail in
[`Password-Reset-Setup.md`](Password-Reset-Setup.md).

## Redeploying after a change to Code.gs

Apps Script serves the **deployed** version, not the saved one. After editing:

**Deploy → Manage deployments → (pencil icon) → Version: New version → Deploy**

The `/exec` URL stays the same. Creating a *new deployment* instead would mint
a different URL and you would have to update `API` again.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Header stuck on *Could not reach the Sheet* | `API` is wrong, or the deployment is not set to *Anyone* |
| *Sheet is empty — sign in as admin and click "Save to Sheet"* | Expected on a fresh Sheet. Sign in, then click **Save to Sheet** |
| Presence never leaves Offline for other devices | `setup()` was never run, so the `Presence` sheet does not exist |
| Reset email never arrives | Gmail send quota, or the account has no Gmail. The screen falls back to showing the link |
| Edits vanish after a reload | You edited without clicking **Save to Sheet**, and the 60s auto-refresh pulled the Sheet's copy back |
