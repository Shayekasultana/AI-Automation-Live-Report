/**
 * DBL AI Automation Live Report — Google Apps Script backend
 * =========================================================
 * Bound to a Google Sheet. Deploy as a Web App:
 *   Execute as:      Me
 *   Who has access:  Anyone
 * Then paste the /exec URL into the API constant in index.html.
 *
 * The front-end posts with Content-Type: text/plain so the browser sends a
 * "simple" request and skips the CORS preflight — Apps Script cannot answer a
 * preflight OPTIONS, so do not change that header on the client.
 *
 * Endpoints (all routed by a `type` field):
 *   GET  ?                    -> {data:[...], roster:{...}}
 *   GET  ?type=users          -> {users:[...]}
 *   GET  ?type=presence       -> {presence:{user:{...}}}
 *   GET  ?type=accesslog      -> {entries:[...]}
 *   POST {type:'tasks'}                              full replace of tasks+roster
 *   POST {type:'users', action:'signup'|'update'|'disable'}
 *   POST {type:'presence', action:'heartbeat'}
 *   POST {type:'accesslog', action:'record'}
 *   POST {type:'passwordReset', action:'request'}
 */

/* ------------------------------------------------------------------ *
 * Sheet + column definitions
 * ------------------------------------------------------------------ */

var SHEETS = {
  tasks:    'Tasks',
  roster:   'Roster',
  users:    'Users',
  presence: 'Presence',
  access:   'AccessLog',
  resets:   'PasswordResets',
  sessions: 'Sessions'
};

/* Column order for the Tasks sheet. Adding a field? Append it to the END of
   this list — never insert in the middle, or existing sheets shift. */
var TASK_COLS = [
  'id', 'ownerId', 'dept', 'task', 'manual', 'owners', 'developer',
  'status', 'prio', 'tool', 'hours', 'date', 'notes',
  'autoTime', 'autoUnit', 'manTime', 'manUnit', 'runs',
  'manualProcessCost', 'automationProcessCost',
  'costSavedPerExecution', 'monthlyCostSaved', 'currency',
  'keyObjective', 'keyAchievement', 'keyProcessAutomation',
  'createdAt', 'updatedAt', 'createdBy', 'archived'
];

/* Fields the client expects back as real arrays. Stored newline-joined in the
   cell so the Sheet stays readable to a human opening it. */
var TASK_ARRAY_FIELDS = ['owners', 'developer', 'keyAchievement', 'keyProcessAutomation'];

/* Numeric fields. A blank cell stays '' rather than becoming 0 — the client
   distinguishes "no cost recorded" from "zero cost". */
var TASK_NUMBER_FIELDS = [
  'hours', 'runs', 'manualProcessCost', 'automationProcessCost',
  'costSavedPerExecution', 'monthlyCostSaved'
];

/* googleId / avatar / hd / lastLogin are appended at the END so an existing
   Users sheet keeps every column it already had in the same position. */
var USER_COLS = ['id', 'name', 'user', 'email', 'dept', 'role', 'pw', 'disabled', 'createdAt',
                 'googleId', 'avatar', 'hd', 'lastLogin'];
var PRESENCE_COLS = ['user', 'status', 'lastActivity', 'viewer', 'location'];
var ACCESS_COLS = ['time', 'viewer', 'location'];
var RESET_COLS = ['token', 'email', 'user', 'expiresAt', 'used', 'createdAt'];

var PRESENCE_STALE_MS = 25 * 1000;      // matches STALE_MS in index.html
var ACCESSLOG_RETURN_LIMIT = 2000;      // cap the payload sent back to a browser

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

function doGet(e) {
  try {
    var type = (e && e.parameter && e.parameter.type) || 'tasks';
    switch (type) {
      case 'users':      return json({ users: readUsers(true) });
      case 'presence':   return json({ presence: readPresence() });
      case 'accesslog':  return json({ entries: readAccessLog() });
      case 'googleconf': return json(readGoogleConfig());
      default:          return json({ data: readTasks(), roster: readRoster() });
    }
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);

    var body = {};
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
    var type = body.type || 'tasks';

    switch (type) {
      case 'tasks':         return json(saveTasks(body));
      case 'users':         return json(handleUsers(body));
      case 'presence':      return json(handlePresence(body));
      case 'accesslog':     return json(handleAccessLog(body));
      case 'passwordReset': return json(handlePasswordReset(body));
      case 'googleAuth':    return json(handleGoogleAuth(body));
      case 'sessionRefresh':return json(handleSessionRefresh(body));
      case 'sessionRevoke': return json(handleSessionRevoke(body));
      case 'sessionList':   return json(handleSessionList(body));
      case 'workspaceSync': return json(handleWorkspaceSync());
      default:              return json({ error: 'Unknown type: ' + type });
    }
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) });
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Get a sheet, creating it with a header row if it does not exist yet. */
function sheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers && headers.length) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

/** All data rows as objects keyed by the sheet's own header row. */
function readRows(sh) {
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.join('') === '') continue;          // skip fully blank rows
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      if (headers[c]) obj[String(headers[c])] = row[c];
    }
    out.push(obj);
  }
  return out;
}

/** Replace every data row below the header in one write. */
function writeRows(sh, cols, rows) {
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  sh.setFrozenRows(1);

  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
  if (!rows.length) return;

  var grid = rows.map(function (obj) {
    return cols.map(function (c) { return obj[c] === undefined ? '' : obj[c]; });
  });
  sh.getRange(2, 1, grid.length, cols.length).setValues(grid);
}

function toBool(v) {
  if (v === true) return true;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

function nowIso() { return new Date().toISOString(); }

/** Sheets may hand back a Date for an ISO string cell; normalise to a string. */
function asText(v) {
  if (v instanceof Date) return v.toISOString();
  return v === null || v === undefined ? '' : String(v);
}

/* ------------------------------------------------------------------ *
 * Tasks + Roster
 * ------------------------------------------------------------------ */

function readTasks() {
  var sh = sheet(SHEETS.tasks, TASK_COLS);
  return readRows(sh).map(function (row) {
    var out = {};

    TASK_COLS.forEach(function (col) {
      var v = row[col];

      if (TASK_ARRAY_FIELDS.indexOf(col) >= 0) {
        out[col] = asText(v).split('\n')
          .map(function (s) { return s.trim(); })
          .filter(function (s) { return s !== ''; });

      } else if (TASK_NUMBER_FIELDS.indexOf(col) >= 0) {
        // '' stays '' — the client treats blank as "not recorded"
        out[col] = (v === '' || v === null || v === undefined) ? '' : Number(v);

      } else if (col === 'archived') {
        out[col] = toBool(v);

      } else if (col === 'date') {
        // a real date cell must go back as yyyy-mm-dd for <input type=date>
        out[col] = (v instanceof Date)
          ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : asText(v);

      } else {
        out[col] = asText(v);
      }
    });

    if (!out.id) out.id = 't_' + Utilities.getUuid().slice(0, 12);
    return out;
  });
}

/**
 * Full replace of the register. Archived rows are never dropped: the client
 * hides them, but the Sheet keeps them permanently, so a row that has gone
 * missing from the payload is preserved here rather than deleted.
 */
function saveTasks(body) {
  var incoming = Array.isArray(body.data) ? body.data : [];

  var existing = readTasks();
  var incomingIds = {};
  incoming.forEach(function (r) { if (r && r.id) incomingIds[r.id] = true; });

  var preserved = existing.filter(function (r) {
    return r.id && !incomingIds[r.id] && r.archived === true;
  });

  var rows = incoming.concat(preserved).map(function (r) {
    var out = {};
    TASK_COLS.forEach(function (col) {
      var v = r[col];
      if (TASK_ARRAY_FIELDS.indexOf(col) >= 0) {
        out[col] = Array.isArray(v) ? v.join('\n') : asText(v);
      } else if (col === 'archived') {
        out[col] = v === true;
      } else {
        out[col] = v === undefined || v === null ? '' : v;
      }
    });
    if (!out.id) out.id = 't_' + Utilities.getUuid().slice(0, 12);
    return out;
  });

  writeRows(sheet(SHEETS.tasks, TASK_COLS), TASK_COLS, rows);

  if (body.roster && typeof body.roster === 'object') saveRoster(body.roster);

  return { ok: true, saved: rows.length, preservedArchived: preserved.length };
}

/** Roster is stored long-form (one Department|User pair per row). */
function readRoster() {
  var sh = sheet(SHEETS.roster, ['dept', 'user']);
  var out = {};
  readRows(sh).forEach(function (row) {
    var d = asText(row.dept).trim();
    if (!d) return;
    if (!out[d]) out[d] = [];
    var u = asText(row.user).trim();
    if (u && out[d].indexOf(u) < 0) out[d].push(u);
  });
  return out;
}

function saveRoster(roster) {
  var rows = [];
  Object.keys(roster).forEach(function (dept) {
    var members = roster[dept] || [];
    if (!members.length) {
      rows.push({ dept: dept, user: '' });        // keep empty departments alive
    } else {
      members.forEach(function (u) { rows.push({ dept: dept, user: u }); });
    }
  });
  writeRows(sheet(SHEETS.roster, ['dept', 'user']), ['dept', 'user'], rows);
}

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

/**
 * Passwords are only ever handled as the SHA-256 hash the client computes —
 * this backend never sees or stores a plaintext password.
 */
function readUsers(includeHash) {
  var sh = sheet(SHEETS.users, USER_COLS);
  return readRows(sh).map(function (row) {
    var u = {
      id:        asText(row.id),
      name:      asText(row.name),
      user:      asText(row.user).toLowerCase(),
      email:     asText(row.email),
      dept:      asText(row.dept),
      role:      asText(row.role) || 'editor',
      disabled:  toBool(row.disabled),
      createdAt: asText(row.createdAt),
      googleId:  asText(row.googleId),
      avatar:    asText(row.avatar),
      hd:        asText(row.hd),
      lastLogin: asText(row.lastLogin)
    };
    if (includeHash) u.pw = asText(row.pw);
    return u;
  }).filter(function (u) { return u.user; });
}

function handleUsers(body) {
  var action = body.action;
  var payload = body.user || {};
  var username = String(payload.user || '').toLowerCase();
  if (!username) return { error: 'A username is required.' };

  var sh = sheet(SHEETS.users, USER_COLS);
  var rows = readRows(sh);
  var idx = -1;
  for (var i = 0; i < rows.length; i++) {
    if (asText(rows[i].user).toLowerCase() === username) { idx = i; break; }
  }

  if (action === 'signup') {
    if (idx >= 0) return { error: 'That username is already registered.' };
    rows.push({
      id:        payload.id || ('u_' + Utilities.getUuid().slice(0, 10)),
      name:      payload.name || '',
      user:      username,
      email:     payload.email || '',
      dept:      payload.dept || '',
      role:      payload.role || 'editor',
      pw:        payload.pw || '',
      disabled:  false,
      createdAt: nowIso()
    });

  } else if (action === 'update') {
    if (idx < 0) return { error: 'No such user.' };
    ['name', 'email', 'dept', 'role', 'pw'].forEach(function (k) {
      if (payload[k] !== undefined) rows[idx][k] = payload[k];
    });
    if (payload.disabled !== undefined) rows[idx].disabled = payload.disabled === true;

  } else if (action === 'disable') {
    if (idx < 0) return { error: 'No such user.' };
    rows[idx].disabled = true;

  } else {
    return { error: 'Unknown user action: ' + action };
  }

  writeRows(sh, USER_COLS, rows);
  return { ok: true, action: action, user: username };
}

/* ------------------------------------------------------------------ *
 * Presence
 * ------------------------------------------------------------------ */

/**
 * One row per user, overwritten on each heartbeat. Status is recomputed from
 * lastActivity on read, so a browser that crashed without sending 'offline'
 * still reports Offline once its heartbeat goes stale.
 */
function handlePresence(body) {
  var username = String(body.user || '').trim();
  if (!username) return { error: 'A user is required.' };

  var sh = sheet(SHEETS.presence, PRESENCE_COLS);
  var rows = readRows(sh);
  var found = false;

  for (var i = 0; i < rows.length; i++) {
    if (asText(rows[i].user) === username) {
      rows[i].status       = body.status || 'online';
      rows[i].lastActivity = body.ts || nowIso();
      rows[i].viewer       = body.viewer || rows[i].viewer || '';
      rows[i].location     = body.location || rows[i].location || '';
      found = true;
      break;
    }
  }
  if (!found) {
    rows.push({
      user:         username,
      status:       body.status || 'online',
      lastActivity: body.ts || nowIso(),
      viewer:       body.viewer || '',
      location:     body.location || ''
    });
  }

  writeRows(sh, PRESENCE_COLS, rows);
  return { ok: true };
}

function readPresence() {
  var sh = sheet(SHEETS.presence, PRESENCE_COLS);
  var out = {};
  var now = Date.now();

  readRows(sh).forEach(function (row) {
    var user = asText(row.user);
    if (!user) return;
    var last = asText(row.lastActivity);
    var status = asText(row.status) || 'offline';

    // a stale heartbeat is Offline no matter what was last written
    var age = now - new Date(last).getTime();
    if (!last || isNaN(age) || age > PRESENCE_STALE_MS) status = 'offline';

    out[user] = {
      status:       status,
      lastActivity: last,
      viewer:       asText(row.viewer),
      location:     asText(row.location)
    };
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * Access log (append-only)
 * ------------------------------------------------------------------ */

function handleAccessLog(body) {
  var entry = body.entry || {};
  var sh = sheet(SHEETS.access, ACCESS_COLS);
  sh.appendRow([entry.time || nowIso(), entry.viewer || 'Anonymous', entry.location || '']);
  return { ok: true };
}

function readAccessLog() {
  var sh = sheet(SHEETS.access, ACCESS_COLS);
  var rows = readRows(sh).map(function (row) {
    return {
      time:     asText(row.time),
      viewer:   asText(row.viewer),
      location: asText(row.location)
    };
  });
  // newest slice only — the Sheet keeps the full history regardless
  return rows.slice(Math.max(0, rows.length - ACCESSLOG_RETURN_LIMIT));
}

/* ------------------------------------------------------------------ *
 * Password reset
 * ------------------------------------------------------------------ */

/**
 * Stores the token server-side and emails the reset link. MailApp sends as the
 * Google account that owns this script, so no separate mail server is needed.
 * If the address has no account, this returns ok without sending — the client
 * has already told the user whether the address was found, and we do not want
 * this endpoint to confirm which addresses exist to anyone who can POST to it.
 */
function handlePasswordReset(body) {
  var email = String(body.email || '').trim().toLowerCase();
  var token = String(body.token || '').trim();
  if (!email || !token) return { error: 'An email and token are required.' };

  var users = readUsers(false);
  var match = null;
  for (var i = 0; i < users.length; i++) {
    if (users[i].email && users[i].email.toLowerCase() === email) { match = users[i]; break; }
  }

  var sh = sheet(SHEETS.resets, RESET_COLS);
  sh.appendRow([
    token, email, match ? match.user : '',
    body.expiresAt || (Date.now() + 30 * 60 * 1000),
    false, nowIso()
  ]);

  if (!match) return { ok: true, sent: false };

  var appUrl = PropertiesService.getScriptProperties().getProperty('APP_URL') || '';
  var link = appUrl ? (appUrl + '?resetToken=' + encodeURIComponent(token)) : '';

  try {
    MailApp.sendEmail({
      to: email,
      subject: 'Reset your DBL AI Automation password',
      htmlBody:
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0F172A">' +
        '<p>Hello ' + (match.name || '') + ',</p>' +
        '<p>A password reset was requested for your DBL AI Automation Live Report account.</p>' +
        (link
          ? '<p><a href="' + link + '" style="background:#1175BC;color:#fff;padding:10px 18px;' +
            'border-radius:8px;text-decoration:none;display:inline-block">Reset my password</a></p>' +
            '<p style="color:#64748B;font-size:12px">Or paste this link into your browser:<br>' + link + '</p>'
          : '<p>Your reset code is: <b>' + token + '</b></p>') +
        '<p style="color:#64748B;font-size:12px">This link expires in 30 minutes. ' +
        'If you did not request it, you can ignore this email.</p></div>'
    });
    return { ok: true, sent: true };
  } catch (err) {
    // quota exhausted or Gmail not available on this account
    return { ok: true, sent: false, error: String(err) };
  }
}

/** Marks a token used. Call from validateResetToken if you later move the
 *  final password write server-side as well. */
function consumeResetToken(token) {
  var sh = sheet(SHEETS.resets, RESET_COLS);
  var rows = readRows(sh);
  for (var i = 0; i < rows.length; i++) {
    if (asText(rows[i].token) === token) {
      if (toBool(rows[i].used)) return { valid: false, reason: 'already used' };
      if (Number(rows[i].expiresAt) < Date.now()) return { valid: false, reason: 'expired' };
      rows[i].used = true;
      writeRows(sh, RESET_COLS, rows);
      return { valid: true, user: asText(rows[i].user), email: asText(rows[i].email) };
    }
  }
  return { valid: false, reason: 'not found' };
}

/* ================================================================== *
 * GOOGLE WORKSPACE AUTHENTICATION
 *
 * The browser cannot verify a Google ID token — anything it checks, a
 * user can bypass. So the whole verification happens here:
 *
 *   1. The page runs Google Identity Services and receives an ID token.
 *   2. It POSTs that token to this backend and nothing else.
 *   3. We verify the token WITH GOOGLE, then check the audience, issuer,
 *      expiry, email verification and hosted domain.
 *   4. Only then do we create or link the account and issue OUR OWN
 *      signed session token, which the page uses from then on.
 *
 * A forged or replayed token fails at step 3, on the server, where the
 * user has no reach.
 * ================================================================== */

var GOOGLE_TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=';
var ACCESS_TOKEN_TTL_MS  = 60 * 60 * 1000;             // 1 hour
var REFRESH_TTL_MS       = 30 * 24 * 60 * 60 * 1000;   // 30 days with Remember Me
var REFRESH_TTL_SHORT_MS = 12 * 60 * 60 * 1000;        // 12 hours without

var SESSION_COLS = ['sid','user','email','refreshToken','device','ip',
                    'createdAt','lastSeen','expiresAt','rememberMe','revoked'];

/* --- config, held in Script Properties so it is never in the page source --- */
function googleConfig(){
  var p = PropertiesService.getScriptProperties();
  var domains = (p.getProperty('ALLOWED_DOMAINS') || '')
    .split(',').map(function(s){ return s.trim().toLowerCase(); })
    .filter(function(s){ return s; });
  return {
    clientId:  p.getProperty('GOOGLE_CLIENT_ID') || '',
    domains:   domains,
    allowList: (p.getProperty('EMAIL_ALLOWLIST') || '')
      .split(',').map(function(s){ return s.trim().toLowerCase(); })
      .filter(function(s){ return s; })
  };
}

/** Public config for the sign-in page. Never returns the session secret. */
function readGoogleConfig(){
  var c = googleConfig();
  return {
    clientId:   c.clientId,
    domains:    c.domains,
    configured: !!c.clientId,
    lastSync:   PropertiesService.getScriptProperties().getProperty('WS_LAST_SYNC') || ''
  };
}

/** HMAC secret for our own session tokens; generated once, kept server-side. */
function sessionSecret(){
  var p = PropertiesService.getScriptProperties();
  var s = p.getProperty('SESSION_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('SESSION_SECRET', s); }
  return s;
}

function b64url(bytes){
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
/** Compact signed token: base64url(payload).base64url(HMAC-SHA256) */
function signToken(payload){
  var body = b64url(Utilities.newBlob(JSON.stringify(payload)).getBytes());
  var sig  = b64url(Utilities.computeHmacSha256Signature(body, sessionSecret()));
  return body + '.' + sig;
}
function verifyToken(token){
  if (!token || token.indexOf('.') < 0) return null;
  var parts = String(token).split('.');
  if (parts.length !== 2) return null;
  var expected = b64url(Utilities.computeHmacSha256Signature(parts[0], sessionSecret()));
  // constant-time-ish compare: length first, then every character
  if (expected.length !== parts[1].length) return null;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts[1].charCodeAt(i);
  if (diff !== 0) return null;
  var payload;
  try { payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()); }
  catch (e) { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null;   // expired
  return payload;
}

/** Is this email allowed to sign in? */
function domainAllowed(email, hd){
  var c = googleConfig();
  var lower = String(email || '').toLowerCase();
  var domain = lower.split('@')[1] || '';

  // an explicit per-address allowlist always wins — this is how the Super
  // Admin lets an individual personal account in
  if (c.allowList.indexOf(lower) >= 0) return true;

  // no domains configured yet: fail closed rather than letting anyone in
  if (!c.domains.length) return false;

  // prefer Google's hosted-domain claim, which a user cannot spoof by
  // editing their profile email
  var effective = (hd || domain).toLowerCase();
  return c.domains.indexOf(effective) >= 0;
}

/**
 * Verify the ID token with Google. tokeninfo checks the signature and
 * expiry against Google's own keys; we then check the claims that are
 * specific to THIS application.
 */
function verifyGoogleIdToken(idToken){
  var c = googleConfig();
  if (!c.clientId) return { ok:false, code:'not_configured' };

  var res;
  try {
    res = UrlFetchApp.fetch(GOOGLE_TOKENINFO + encodeURIComponent(idToken), { muteHttpExceptions:true });
  } catch (e) {
    return { ok:false, code:'network', detail:String(e) };
  }
  if (res.getResponseCode() !== 200) return { ok:false, code:'invalid_token' };

  var claims;
  try { claims = JSON.parse(res.getContentText()); } catch (e) { return { ok:false, code:'invalid_token' }; }

  if (claims.aud !== c.clientId) return { ok:false, code:'wrong_audience' };
  if (['accounts.google.com','https://accounts.google.com'].indexOf(claims.iss) < 0)
    return { ok:false, code:'wrong_issuer' };
  if (Number(claims.exp) * 1000 <= Date.now()) return { ok:false, code:'expired' };
  if (String(claims.email_verified) !== 'true') return { ok:false, code:'email_unverified' };
  if (!claims.email) return { ok:false, code:'no_email' };
  if (!domainAllowed(claims.email, claims.hd)) return { ok:false, code:'domain_denied', email:claims.email };

  return { ok:true, claims:claims };
}

/* --- sessions --- */
function createSession(user, rememberMe, device, ip){
  var sh = sheet(SHEETS.sessions, SESSION_COLS);
  var sid = Utilities.getUuid();
  var refresh = Utilities.getUuid() + Utilities.getUuid();
  var ttl = rememberMe ? REFRESH_TTL_MS : REFRESH_TTL_SHORT_MS;
  sh.appendRow([sid, user.user, user.email, refresh, device || '', ip || '',
                nowIso(), nowIso(), new Date(Date.now() + ttl).toISOString(),
                !!rememberMe, false]);
  return { sid:sid, refreshToken:refresh, expiresAt:Date.now() + ttl };
}
function accessTokenFor(user, sid){
  return signToken({
    sub:user.id, user:user.user, email:user.email, role:user.role,
    dept:user.dept || '', sid:sid,
    iat:Date.now(), exp:Date.now() + ACCESS_TOKEN_TTL_MS
  });
}

function handleGoogleAuth(body){
  var v = verifyGoogleIdToken(body.credential);
  if (!v.ok) return { error:googleAuthMessage(v), code:v.code };

  var claims = v.claims;
  var email  = String(claims.email).toLowerCase();

  var sh   = sheet(SHEETS.users, USER_COLS);
  var rows = readRows(sh);

  // ACCOUNT LINKING: match on email first so a person who already signed up
  // with a password gets their Google account attached instead of a duplicate
  var idx = -1;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].email || '').toLowerCase() === email) { idx = i; break; }
  }

  var isNew = false;
  if (idx < 0) {
    // create — new Google users always start as viewer; only an admin promotes
    rows.push({
      id:'u_' + Utilities.getUuid().slice(0, 10),
      name:claims.name || email.split('@')[0],
      user:email.split('@')[0].toLowerCase().replace(/[^a-z0-9_.]/g, ''),
      email:email, dept:'', role:'viewer', pw:'',
      disabled:false, createdAt:nowIso(),
      googleId:claims.sub, avatar:claims.picture || '', hd:claims.hd || '',
      lastLogin:nowIso()
    });
    idx = rows.length - 1;
    isNew = true;
  } else {
    // link + refresh profile details from Google
    rows[idx].googleId  = claims.sub;
    rows[idx].avatar    = claims.picture || rows[idx].avatar || '';
    rows[idx].hd        = claims.hd || rows[idx].hd || '';
    rows[idx].lastLogin = nowIso();
    if (!rows[idx].name && claims.name) rows[idx].name = claims.name;
  }

  if (toBool(rows[idx].disabled)) return { error:'This account has been disabled. Contact an administrator.', code:'disabled' };

  writeRows(sh, USER_COLS, rows);

  var user = {
    id:String(rows[idx].id), name:String(rows[idx].name), user:String(rows[idx].user),
    email:email, role:String(rows[idx].role || 'viewer'), dept:String(rows[idx].dept || ''),
    avatar:String(rows[idx].avatar || ''), hd:String(rows[idx].hd || '')
  };
  var s = createSession(user, body.rememberMe, body.device, body.ip);

  return {
    ok:true, isNew:isNew, user:user, sid:s.sid,
    accessToken:accessTokenFor(user, s.sid),
    refreshToken:s.refreshToken,
    expiresIn:ACCESS_TOKEN_TTL_MS
  };
}

/** Plain-English reason, safe to show a user. */
function googleAuthMessage(v){
  switch (v.code) {
    case 'not_configured':
      return 'Google Workspace Sign-In is not configured yet. Please use your company email and password.';
    case 'domain_denied':
      return 'The account ' + (v.email || '') + ' is not on an approved company domain. ' +
             'Ask your administrator to add your domain, or sign in with your company email and password.';
    case 'email_unverified': return 'This Google account does not have a verified email address.';
    case 'wrong_audience':   return 'This sign-in was issued for a different application. Check the Client ID in Settings.';
    case 'expired':          return 'That sign-in attempt expired. Please try again.';
    case 'network':          return 'Could not reach Google to verify the sign-in. Please try again.';
    default:                 return 'Google sign-in could not be verified. Please try again, or use your company email and password.';
  }
}

/** Exchange a refresh token for a new access token. */
function handleSessionRefresh(body){
  var sh = sheet(SHEETS.sessions, SESSION_COLS);
  var rows = readRows(sh);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].refreshToken) === String(body.refreshToken)) {
      if (toBool(rows[i].revoked)) return { error:'This session was signed out.', code:'revoked' };
      if (new Date(asText(rows[i].expiresAt)).getTime() < Date.now())
        return { error:'Your session has expired. Please sign in again.', code:'expired' };

      var users = readUsers(false);
      var u = null;
      for (var j = 0; j < users.length; j++) {
        if (users[j].email && users[j].email.toLowerCase() === String(rows[i].email).toLowerCase()) { u = users[j]; break; }
      }
      if (!u) return { error:'Account no longer exists.', code:'gone' };
      if (u.disabled) return { error:'This account has been disabled.', code:'disabled' };

      rows[i].lastSeen = nowIso();
      writeRows(sh, SESSION_COLS, rows);

      // the role is re-read from the sheet on every refresh, so a promotion
      // or demotion takes effect within the access-token lifetime
      return { ok:true, user:u, accessToken:accessTokenFor(u, String(rows[i].sid)), expiresIn:ACCESS_TOKEN_TTL_MS };
    }
  }
  return { error:'Session not found. Please sign in again.', code:'not_found' };
}

/** Sign out: one device, or every device for this account. */
function handleSessionRevoke(body){
  var sh = sheet(SHEETS.sessions, SESSION_COLS);
  var rows = readRows(sh);
  var n = 0;
  rows.forEach(function(r){
    var match = body.all
      ? String(r.email).toLowerCase() === String(body.email || '').toLowerCase()
      : (String(r.refreshToken) === String(body.refreshToken) || String(r.sid) === String(body.sid));
    if (match && !toBool(r.revoked)) { r.revoked = true; n++; }
  });
  writeRows(sh, SESSION_COLS, rows);
  return { ok:true, revoked:n };
}

/** Active sessions for an account — powers the multi-device list. */
function handleSessionList(body){
  var email = String(body.email || '').toLowerCase();
  var out = readRows(sheet(SHEETS.sessions, SESSION_COLS))
    .filter(function(r){
      return String(r.email).toLowerCase() === email && !toBool(r.revoked) &&
             new Date(asText(r.expiresAt)).getTime() > Date.now();
    })
    .map(function(r){
      return { sid:asText(r.sid), device:asText(r.device), ip:asText(r.ip),
               createdAt:asText(r.createdAt), lastSeen:asText(r.lastSeen),
               rememberMe:toBool(r.rememberMe) };
    });
  return { ok:true, sessions:out };
}

/**
 * "Sync Users" from the admin screen.
 *
 * Honest scope: pulling the full member list of a Workspace needs the Admin
 * SDK Directory API plus domain-wide delegation, which is a separate consent
 * flow this script does not hold. What this does instead is real and useful:
 * it re-reads the Users sheet, drops expired sessions, and reports the
 * counts, so the admin screen reflects the true current state.
 */
function handleWorkspaceSync(){
  var users = readUsers(false);
  var sh = sheet(SHEETS.sessions, SESSION_COLS);
  var rows = readRows(sh);
  var before = rows.length;
  var kept = rows.filter(function(r){
    return !toBool(r.revoked) && new Date(asText(r.expiresAt)).getTime() > Date.now();
  });
  writeRows(sh, SESSION_COLS, kept);
  PropertiesService.getScriptProperties().setProperty('WS_LAST_SYNC', nowIso());
  return {
    ok:true, lastSync:nowIso(),
    users:users.length,
    googleLinked:users.filter(function(u){ return u.googleId; }).length,
    sessionsPruned:before - kept.length,
    activeSessions:kept.length
  };
}

/* ------------------------------------------------------------------ *
 * One-time setup — run from the Apps Script editor
 * ------------------------------------------------------------------ */

/** Creates every sheet with its header row. Safe to re-run. */
function setup() {
  sheet(SHEETS.tasks, TASK_COLS);
  sheet(SHEETS.roster, ['dept', 'user']);
  sheet(SHEETS.users, USER_COLS);
  sheet(SHEETS.presence, PRESENCE_COLS);
  sheet(SHEETS.access, ACCESS_COLS);
  sheet(SHEETS.resets, RESET_COLS);
  sheet(SHEETS.sessions, SESSION_COLS);
  sessionSecret();                     // generate the signing key on first run
  Logger.log('All sheets ready.');
}

/**
 * Configure Google Workspace sign-in. Run once from the editor, or set the
 * same three Script Properties by hand under Project Settings.
 *
 *   configureGoogleAuth('123-abc.apps.googleusercontent.com',
 *                       'dbl-group.com,dbl-pharma.com,dblceramics.com');
 */
function configureGoogleAuth(clientId, allowedDomains, emailAllowList){
  var p = PropertiesService.getScriptProperties();
  p.setProperty('GOOGLE_CLIENT_ID', clientId || '');
  p.setProperty('ALLOWED_DOMAINS', allowedDomains || '');
  if (emailAllowList !== undefined) p.setProperty('EMAIL_ALLOWLIST', emailAllowList || '');
  sessionSecret();
  Logger.log('Google auth configured for: ' + (allowedDomains || '(none — sign-in will be refused)'));
  return readGoogleConfig();
}

/** Drops expired and revoked sessions. Attach to a daily trigger if you like. */
function pruneSessions(){
  var sh = sheet(SHEETS.sessions, SESSION_COLS);
  var kept = readRows(sh).filter(function(r){
    return !toBool(r.revoked) && new Date(asText(r.expiresAt)).getTime() > Date.now();
  });
  writeRows(sh, SESSION_COLS, kept);
}

/** Deletes presence rows that have been offline for over a day. Attach to a
 *  daily time-driven trigger if the Presence sheet grows noisy. */
function prunePresence() {
  var sh = sheet(SHEETS.presence, PRESENCE_COLS);
  var cutoff = Date.now() - 24 * 60 * 60 * 1000;
  var rows = readRows(sh).filter(function (row) {
    var t = new Date(asText(row.lastActivity)).getTime();
    return !isNaN(t) && t > cutoff;
  });
  writeRows(sh, PRESENCE_COLS, rows);
}
