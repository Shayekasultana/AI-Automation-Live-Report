# Password reset — setup

The dashboard's own source refers to this file. The front-end flow was already
complete (token generation, 30-minute expiry, strength meter, rule checklist,
single-use tokens); what was missing was the backend half. That now lives in
`handlePasswordReset` in [`../backend/Code.gs`](../backend/Code.gs).

## What sends the email

`MailApp.sendEmail`, running as the Google account that owns the Apps Script
project. There is no separate mail server, SMTP config, or third-party service.

Quotas: 100 recipients/day on a consumer Gmail account, 1,500/day on Workspace.
Ample for password resets.

## Enabling one-click links

Without configuration the email contains the raw token and the user pastes it
back. To send a working link instead:

1. Apps Script editor → **Project Settings**
2. **Script Properties → Add script property**
3. Name `APP_URL`, value = wherever `index.html` is hosted, for example
   `https://dbl-it.example.com/automation/index.html`
4. Save, then **Deploy → Manage deployments → New version**

The script then builds `APP_URL + '?resetToken=' + token`. On load,
`checkResetTokenInUrl()` in `index.html` reads that parameter and opens the
"Choose a new password" step directly.

## Flow

1. User clicks **Forgot password?** and enters their email.
2. Client mints a 160-bit token, stores it in `localStorage` with a 30-minute
   expiry, and POSTs `{type:'passwordReset', action:'request', …}`.
3. Backend appends the token to the `PasswordResets` sheet and emails the link.
4. User opens the link. `openResetToken` validates the token and its expiry.
5. New password must have 8+ characters, upper, lower, a digit and a symbol.
   The client hashes it and pushes the hash via `{type:'users',
   action:'update'}`.
6. The token is deleted client-side — single use.

## Two honest limitations

**Built-in accounts cannot be reset here.** `shayeka`, `rakib` and `nasir` have
their password hashes hardcoded in the `USERS` array in `index.html`. There is
no stored record for the reset flow to update, so it declines rather than
silently appearing to succeed. To change one, run
`await hashPw('theNewPassword')` in the browser console and paste the result
into that user's `pw` field in the source.

**Expiry is enforced client-side for the final write.** The token and its
expiry are recorded server-side by `handlePasswordReset`, and
`consumeResetToken` in `Code.gs` is ready to enforce it — but the password
write itself currently goes through the ordinary `users/update` endpoint, which
does not check the token. Someone who can POST directly could set a password
without a valid token. See the security note in
[`../README.md`](../README.md); closing this properly means moving the password
write into a dedicated server-side endpoint that calls `consumeResetToken`
first.
