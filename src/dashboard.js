// The status dashboard: a single self-contained HTML page served at
// GET /teamclaude/dashboard, rendering /teamclaude/status for humans.
//
// The page itself contains NO data — it is a static asset whose script fetches
// /teamclaude/status (same origin) with the proxy key and re-renders every few
// seconds. That split is what lets the asset be served without the key (a
// browser address bar cannot send x-api-key) while every byte of actual status
// stays behind the existing gate. The key is asked for once and kept in
// localStorage; a 401 (wrong or rotated key) brings the prompt back.
//
// Self-contained on purpose: no external scripts, styles, or fonts, so the
// page works on air-gapped deployments and adds no third-party surface. All
// rendering uses textContent — status fields (account names, client names) are
// operator/OAuth-derived, but they still never reach innerHTML.

export function renderDashboardHtml() {
  return PAGE;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeamClaude</title>
<style>
  :root {
    --bg: #101418; --panel: #171d24; --line: #242c36;
    --text: #d7dde4; --dim: #8a949f; --accent: #53b1fd;
    --ok: #3fb950; --warn: #d29922; --bad: #f85149;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; padding: 24px; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  h2 { font-size: 13px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; margin: 24px 0 8px; }
  .sub { color: var(--dim); margin-bottom: 16px; }
  .sub b { color: var(--text); font-weight: 600; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; }
  .row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .name { font-weight: 600; }
  .tag { font-size: 12px; color: var(--dim); }
  .badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); }
  .badge.active { color: var(--ok); border-color: var(--ok); }
  .badge.throttled { color: var(--warn); border-color: var(--warn); }
  .badge.error, .badge.exhausted { color: var(--bad); border-color: var(--bad); }
  .badge.current { color: var(--accent); border-color: var(--accent); }
  .quota { display: grid; grid-template-columns: 64px 1fr 170px; gap: 8px; align-items: center; margin-top: 6px; }
  .quota .lbl { color: var(--dim); font-size: 12px; }
  .quota .val { color: var(--dim); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
  .bar { height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 4px; background: var(--ok); }
  .bar i.warn { background: var(--warn); }
  .bar i.bad { background: var(--bad); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 10px; font-variant-numeric: tabular-nums; }
  th { color: var(--dim); font-size: 12px; font-weight: 500; border-bottom: 1px solid var(--line); }
  td { border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; }
  .filters { display: flex; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  .filters label { color: var(--dim); font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .filters select { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; font-size: 12px; padding: 4px 24px 4px 8px; }
  .usage { color: var(--dim); font-size: 12px; margin-top: 6px; }
  #err { color: var(--bad); margin: 12px 0; display: none; }
  #keybox { display: none; margin: 40px auto; max-width: 420px; text-align: center; }
  #keybox input { width: 100%; padding: 10px 12px; margin: 12px 0; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; }
  #keybox button { padding: 8px 20px; background: var(--accent); border: 0; border-radius: 6px; color: #06121f; font: inherit; font-weight: 600; cursor: pointer; }
  footer { color: var(--dim); font-size: 12px; margin-top: 24px; }
</style>
</head>
<body>
<main>
  <div id="keybox">
    <h1>TeamClaude</h1>
    <p class="sub">Enter your proxy key to view status.</p>
    <input id="key" type="password" placeholder="tc-..." autocomplete="off">
    <br><button id="go">Connect</button>
  </div>
  <div id="app" style="display:none">
    <h1>TeamClaude</h1>
    <p class="sub" id="summary"></p>
    <div id="err"></div>
    <h2>Accounts</h2>
    <div id="accounts"></div>
    <div id="clientsWrap" style="display:none">
      <h2>Clients</h2>
      <div class="card" style="padding:4px 6px"><table id="clients"></table></div>
    </div>
    <div id="dimensions"></div>
    <footer id="foot"></footer>
  </div>
</main>
<script>
(function () {
  'use strict';
  var KEY = 'teamclaude-dashboard-key';
  var POLL_MS = 5000;
  var timer = null;
  var lastStatus = null;
  var sessionFilters = { project: '', client: '' };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  // Status timestamps arrive in both shapes: epoch milliseconds (account
  // quota resets, account usage.lastUsed) and ISO strings (client lastUsed).
  // Date.parse() only handles strings, so numbers must pass through as-is —
  // feeding it a number silently yields NaN and the field just never renders.
  function parseTs(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    return Date.parse(v);
  }

  function fmtAgo(ts) {
    var t = parseTs(ts);
    if (isNaN(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function fmtIn(sec) {
    if (sec == null) return '';
    var s = Math.max(0, Math.round(sec));
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return (s / 3600).toFixed(1) + 'h';
    return (s / 86400).toFixed(1) + 'd';
  }

  // Absolute wall-clock of a future timestamp: "17:30" today, "Wed 09:00"
  // beyond 24h — the countdown says how long, this says when.
  function fmtClock(ts) {
    var d = new Date(ts);
    var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (ts - Date.now() >= 86400000) {
      return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
    }
    return time;
  }

  function quotaRow(label, ratio, resetAt) {
    var row = el('div', 'quota');
    row.appendChild(el('span', 'lbl', label));
    var bar = el('div', 'bar');
    var fill = el('i');
    var pct = ratio == null ? null : Math.max(0, Math.min(1, Number(ratio)));
    fill.style.width = (pct == null ? 0 : pct * 100) + '%';
    if (pct != null && pct >= 0.9) fill.className = 'bad';
    else if (pct != null && pct >= 0.7) fill.className = 'warn';
    bar.appendChild(fill);
    row.appendChild(bar);
    var resetTs = parseTs(resetAt);
    var reset = !isNaN(resetTs) && resetTs > Date.now()
      ? ' · ' + fmtIn((resetTs - Date.now()) / 1000) + ' · ' + fmtClock(resetTs)
      : '';
    row.appendChild(el('span', 'val', (pct == null ? '?' : Math.round(pct * 100) + '%') + reset));
    return row;
  }

  function renderAccount(a, current) {
    var card = el('div', 'card');
    var head = el('div', 'row');
    head.appendChild(el('span', 'name', a.name));
    head.appendChild(el('span', 'tag', a.type + ' · prio ' + (a.priority || 0)));
    if (a.name === current) head.appendChild(el('span', 'badge current', 'current'));
    head.appendChild(el('span', 'badge ' + (a.status || ''), a.disabled ? 'disabled' : (a.status || 'unknown')));
    if (a.sessions) head.appendChild(el('span', 'tag', a.sessions + ' active session' + (a.sessions > 1 ? 's' : '')));
    card.appendChild(head);
    var q = a.quota || {};
    if (q.unified5h != null || q.unified7d != null) {
      card.appendChild(quotaRow('Session', q.unified5h, q.unified5hReset));
      card.appendChild(quotaRow('Weekly', q.unified7d, q.unified7dReset));
      if (q.unified7dSonnet != null) card.appendChild(quotaRow('Sonnet', q.unified7dSonnet, q.unified7dSonnetReset));
      if (q.unified7dFable != null) card.appendChild(quotaRow('Fable', q.unified7dFable, q.unified7dFableReset));
    } else if (q.tokensLimit != null && q.tokensRemaining != null) {
      card.appendChild(quotaRow('Tokens', 1 - q.tokensRemaining / q.tokensLimit, q.resetsAt));
    } else {
      card.appendChild(el('div', 'usage', 'quota unknown (no traffic observed yet)'));
    }
    var u = a.usage || {};
    var tok = (u.totalInputTokens || 0) + (u.totalOutputTokens || 0);
    var last = u.lastUsed ? ' · last ' + fmtAgo(u.lastUsed) : '';
    card.appendChild(el('div', 'usage', (u.totalRequests || 0) + ' req · ' + fmtNum(tok) + ' tok' + last));
    return card;
  }

  function renderClients(clients) {
    var wrap = document.getElementById('clientsWrap');
    var names = Object.keys(clients || {});
    if (!names.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    names.sort(function (a, b) {
      var ca = clients[a], cb = clients[b];
      return ((cb.inputTokens || 0) + (cb.outputTokens || 0)) - ((ca.inputTokens || 0) + (ca.outputTokens || 0));
    });
    var table = document.getElementById('clients');
    table.textContent = '';
    var hr = el('tr');
    ['Client', 'Requests', 'Input tok', 'Output tok', 'Last used'].forEach(function (h, i) {
      hr.appendChild(el('th', i ? 'num' : '', h));
    });
    table.appendChild(hr);
    names.forEach(function (n) {
      var c = clients[n];
      var tr = el('tr');
      tr.appendChild(el('td', '', n));
      tr.appendChild(el('td', 'num', fmtNum(c.requests)));
      tr.appendChild(el('td', 'num', fmtNum(c.inputTokens)));
      tr.appendChild(el('td', 'num', fmtNum(c.outputTokens)));
      tr.appendChild(el('td', 'num', c.lastUsed ? fmtAgo(c.lastUsed) : '—'));
      table.appendChild(tr);
    });
  }

  function titleForDimension(name) {
    if (name === 'session') return 'Sessions usage';
    return name.charAt(0).toUpperCase() + name.slice(1) + ' usage';
  }

  function renderUsageTable(table, entries, firstHeader) {
    var names = Object.keys(entries || {});
    names.sort(function (a, b) {
      var ca = entries[a], cb = entries[b];
      return ((cb.inputTokens || 0) + (cb.outputTokens || 0)) - ((ca.inputTokens || 0) + (ca.outputTokens || 0));
    });
    table.textContent = '';
    var hr = el('tr');
    [firstHeader, 'Requests', 'Input tok', 'Output tok', 'Last used'].forEach(function (h, i) {
      hr.appendChild(el('th', i ? 'num' : '', h));
    });
    table.appendChild(hr);
    names.forEach(function (n) {
      var c = entries[n];
      var tr = el('tr');
      tr.appendChild(el('td', '', n));
      tr.appendChild(el('td', 'num', fmtNum(c.requests)));
      tr.appendChild(el('td', 'num', fmtNum(c.inputTokens)));
      tr.appendChild(el('td', 'num', fmtNum(c.outputTokens)));
      tr.appendChild(el('td', 'num', c.lastUsed ? fmtAgo(c.lastUsed) : '—'));
      table.appendChild(tr);
    });
  }

  function sessionMetaById(sessions) {
    var out = {};
    (sessions.items || []).forEach(function (session) {
      if (session && session.id) out[session.id] = session;
    });
    return out;
  }

  function renderFilter(select, values, value) {
    select.textContent = '';
    select.appendChild(el('option', '', 'All'));
    select.options[0].value = '';
    values.forEach(function (v) {
      var option = el('option', '', v);
      option.value = v;
      select.appendChild(option);
    });
    select.value = values.indexOf(value) === -1 ? '' : value;
  }

  function uniqSorted(values) {
    var seen = {};
    values.forEach(function (v) { if (v) seen[v] = true; });
    return Object.keys(seen).sort();
  }

  function renderSessionUsage(entries, sessions) {
    var meta = sessionMetaById(sessions || {});
    var rows = Object.keys(entries || {}).map(function (id) {
      var usage = entries[id] || {};
      var session = meta[id] || {};
      var dimensions = session.dimensions || {};
      return {
        id: id,
        project: dimensions.project || '',
        client: session.client || '',
        active: !!session.active,
        requests: usage.requests,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        lastUsed: usage.lastUsed || session.lastSeen,
      };
    });
    rows.sort(function (a, b) {
      return ((b.inputTokens || 0) + (b.outputTokens || 0)) - ((a.inputTokens || 0) + (a.outputTokens || 0));
    });

    var card = el('div', 'card');
    card.style.padding = '0';
    var filters = el('div', 'filters');
    var projectSelect = el('select');
    var clientSelect = el('select');
    renderFilter(projectSelect, uniqSorted(rows.map(function (r) { return r.project; })), sessionFilters.project);
    renderFilter(clientSelect, uniqSorted(rows.map(function (r) { return r.client; })), sessionFilters.client);
    sessionFilters.project = projectSelect.value;
    sessionFilters.client = clientSelect.value;
    projectSelect.addEventListener('change', function () {
      sessionFilters.project = projectSelect.value;
      if (lastStatus) render(lastStatus);
    });
    clientSelect.addEventListener('change', function () {
      sessionFilters.client = clientSelect.value;
      if (lastStatus) render(lastStatus);
    });
    filters.appendChild(el('label', '', 'Project'));
    filters.lastChild.appendChild(projectSelect);
    filters.appendChild(el('label', '', 'Client'));
    filters.lastChild.appendChild(clientSelect);
    card.appendChild(filters);

    rows = rows.filter(function (r) {
      return (!sessionFilters.project || r.project === sessionFilters.project)
        && (!sessionFilters.client || r.client === sessionFilters.client);
    });

    var table = el('table');
    var hr = el('tr');
    ['Session', 'Project', 'Client', 'State', 'Requests', 'Input tok', 'Output tok', 'Last used'].forEach(function (h, i) {
      hr.appendChild(el('th', i >= 4 ? 'num' : '', h));
    });
    table.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', '', r.id));
      tr.appendChild(el('td', '', r.project || '—'));
      tr.appendChild(el('td', '', r.client || '—'));
      tr.appendChild(el('td', '', r.active ? 'active' : 'idle'));
      tr.appendChild(el('td', 'num', fmtNum(r.requests)));
      tr.appendChild(el('td', 'num', fmtNum(r.inputTokens)));
      tr.appendChild(el('td', 'num', fmtNum(r.outputTokens)));
      tr.appendChild(el('td', 'num', r.lastUsed ? fmtAgo(r.lastUsed) : '—'));
      table.appendChild(tr);
    });
    card.appendChild(table);
    return card;
  }

  function renderDimensions(dimensions, sessions) {
    var root = document.getElementById('dimensions');
    root.textContent = '';
    Object.keys(dimensions || {}).sort().forEach(function (name) {
      var entries = dimensions[name] || {};
      if (!Object.keys(entries).length) return;
      root.appendChild(el('h2', '', titleForDimension(name)));
      if (name === 'session') {
        root.appendChild(renderSessionUsage(entries, sessions));
        return;
      }
      var card = el('div', 'card');
      card.style.padding = '4px 6px';
      var table = el('table');
      renderUsageTable(table, entries, name === 'session' ? 'Session' : name);
      card.appendChild(table);
      root.appendChild(card);
    });
  }

  function render(s) {
    lastStatus = s;
    var sess = s.sessions || {};
    var up = s.server && s.server.uptimeSeconds != null ? 'up ' + fmtIn(s.server.uptimeSeconds) : '';
    var sum = document.getElementById('summary');
    sum.textContent = '';
    sum.appendChild(el('span', '', 'active account '));
    sum.appendChild(el('b', '', s.currentAccount || 'none'));
    sum.appendChild(el('span', '', ' · ' + (sess.active || 0) + ' active / ' + (sess.known || 0) + ' known sessions' + (up ? ' · ' + up : '')));
    var acc = document.getElementById('accounts');
    acc.textContent = '';
    (s.accounts || []).forEach(function (a) { acc.appendChild(renderAccount(a, s.currentAccount)); });
    renderClients(s.clients);
    renderDimensions(s.usageDimensions, sess);
    document.getElementById('foot').textContent = 'refreshes every ' + (POLL_MS / 1000) + 's · ' + new Date().toLocaleTimeString();
  }

  function showKeybox() {
    if (timer) { clearInterval(timer); timer = null; }
    document.getElementById('app').style.display = 'none';
    document.getElementById('keybox').style.display = 'block';
    document.getElementById('key').focus();
  }

  function poll() {
    fetch('/teamclaude/status', { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (s) {
        if (!s) return;
        document.getElementById('keybox').style.display = 'none';
        document.getElementById('app').style.display = '';
        document.getElementById('err').style.display = 'none';
        render(s);
      })
      .catch(function (e) {
        var err = document.getElementById('err');
        err.style.display = 'block';
        err.textContent = 'Cannot reach the proxy: ' + e.message;
      });
  }

  function start() {
    poll();
    if (!timer) timer = setInterval(poll, POLL_MS);
  }

  document.getElementById('go').addEventListener('click', function () {
    var v = document.getElementById('key').value.trim();
    if (!v) return;
    localStorage.setItem(KEY, v);
    start();
  });
  document.getElementById('key').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('go').click();
  });

  if (localStorage.getItem(KEY)) start(); else showKeybox();
})();
</script>
</body>
</html>
`;
