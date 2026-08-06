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
  resets:   'PasswordResets'
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

var USER_COLS = ['id', 'name', 'user', 'email', 'dept', 'role', 'pw', 'disabled', 'createdAt'];
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
      case 'users':     return json({ users: readUsers(true) });
      case 'presence':  return json({ presence: readPresence() });
      case 'accesslog': return json({ entries: readAccessLog() });
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
      createdAt: asText(row.createdAt)
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
  Logger.log('All sheets ready.');
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
