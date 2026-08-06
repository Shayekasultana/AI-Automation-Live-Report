# Backend API

Every request goes to the single Apps Script `/exec` URL held in the `API`
constant in `index.html`. Routing is by a `type` parameter (GET) or a `type`
field in the JSON body (POST).

## A note on Content-Type

The client posts with `Content-Type: text/plain;charset=utf-8`, **not**
`application/json`. That keeps each POST a CORS "simple request" so the browser
never sends a preflight `OPTIONS` — which matters because Apps Script web apps
cannot respond to one. The body is still JSON; `doPost` parses
`e.postData.contents` itself. Changing that header on the client breaks every
write with an opaque CORS error.

## GET

| Query | Returns |
| --- | --- |
| *(none)* or `?type=tasks` | `{data: Task[], roster: {dept: string[]}}` |
| `?type=users` | `{users: User[]}` |
| `?type=presence` | `{presence: {key: PresenceEntry}}` |
| `?type=accesslog` | `{entries: AccessEntry[]}` — newest 2000 |

All errors come back as `{error: "…"}` with HTTP 200; the client checks the
field rather than the status code.

The client appends `&t=<timestamp>` to defeat caching.

## POST

### `{type:'tasks', data, roster}`

Full replace of the register and roster.

Archived rows are protected: any row already in the Sheet with
`archived === true` whose `id` is absent from the payload is re-appended rather
than dropped. That is what makes the "Archive" action in the UI honest — the
row disappears from the report but is never actually deleted.

### `{type:'users', action, user}`

| `action` | Behaviour |
| --- | --- |
| `signup` | Appends. Fails with `{error}` if the username exists |
| `update` | Patches `name`, `email`, `dept`, `role`, `pw`, `disabled` |
| `disable` | Sets `disabled = true` |

`user.pw` is always the SHA-256 hash the client computes as
`SHA-256(SALT + password)`. Plaintext passwords never reach this backend.

### `{type:'presence', action:'heartbeat', user, status, ts, viewer, location}`

Upserts one row per user. Sent every 8 seconds while a tab is open, and via
`navigator.sendBeacon` on unload.

`readPresence` recomputes status from `lastActivity`: anything older than 25
seconds is reported `offline` regardless of the stored value, so a crashed tab
that never sent its goodbye still shows correctly.

### `{type:'accesslog', action:'record', entry:{time, viewer, location}}`

Appends one row. Never overwritten.

### `{type:'passwordReset', action:'request', email, token, expiresAt}`

Stores the token and emails the link via `MailApp`.

Returns `{ok:true, sent:false}` when no account matches the address — it does
not report back which addresses exist, since anyone can POST to this endpoint.

## Sheets

| Sheet | Contents |
| --- | --- |
| `Tasks` | One row per automation, columns in `TASK_COLS` order |
| `Roster` | Long-form `dept \| user` pairs |
| `Users` | Self-service accounts (the three built-ins live in `index.html`) |
| `Presence` | One row per user, overwritten each heartbeat |
| `AccessLog` | Append-only visit history |
| `PasswordResets` | Issued tokens with expiry and used flag |

### Storage conventions

- **Array fields** (`owners`, `developer`, `keyAchievement`,
  `keyProcessAutomation`) are stored newline-joined in a single cell so the
  Sheet stays readable to a human, and split back into real arrays on read.
- **Numeric fields** keep `''` as `''` rather than coercing to `0` — the UI
  distinguishes "no cost recorded" from "zero cost saved".
- **Adding a field**: append it to the end of `TASK_COLS`. Inserting in the
  middle shifts every existing sheet's columns.
