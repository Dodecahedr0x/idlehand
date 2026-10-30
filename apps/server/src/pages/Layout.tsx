import type { FC, PropsWithChildren } from 'hono/jsx';
import type { Me } from '@idlehand/shared';

const CSS = `
:root {
  --bg: #fafafa; --fg: #111; --muted: #666; --card: #fff; --border: #e3e3e3;
  --accent: #2f6fed; --accent-fg: #fff; --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0e1013; --fg: #e8e8e8; --muted: #9a9a9a; --card: #16191e; --border: #262b33; --accent: #6ea0ff; --accent-fg: #0b1220; --ok: #3fb950; --warn: #d29922; --bad: #f85149; }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
code, pre { font-family: var(--mono); font-size: 0.92em; }
pre { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
.wrap { max-width: 960px; margin: 0 auto; padding: 0 20px 64px; }
header.top { display: flex; align-items: center; justify-content: space-between; padding: 18px 0; border-bottom: 1px solid var(--border); margin-bottom: 28px; }
header.top .brand { font-weight: 700; font-size: 18px; color: var(--fg); letter-spacing: -0.01em; }
header.top nav { display: flex; gap: 18px; align-items: center; }
header.top nav img { width: 24px; height: 24px; border-radius: 50%; vertical-align: middle; }
h1 { font-size: 30px; letter-spacing: -0.02em; margin: 0 0 8px; }
h2 { font-size: 20px; margin: 36px 0 12px; letter-spacing: -0.01em; }
p.lead { font-size: 17px; color: var(--muted); max-width: 640px; margin: 0 0 20px; }
.muted { color: var(--muted); }
.btn { display: inline-block; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--fg); cursor: pointer; font: inherit; font-weight: 500; }
.btn:hover { border-color: var(--accent); text-decoration: none; }
.btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.btn.danger { color: var(--bad); }
.btn.small { padding: 5px 10px; font-size: 13px; }
.btn[disabled] { opacity: 0.6; cursor: progress; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; min-height: 120px; }
.card .name { font-weight: 600; word-break: break-all; }
.card .desc { color: var(--muted); font-size: 13.5px; flex: 1; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card .meta { display: flex; gap: 12px; font-size: 12.5px; color: var(--muted); align-items: center; }
.card .meta .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); display: inline-block; margin-right: 4px; }
.card .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.toggle.on { background: color-mix(in srgb, var(--ok) 14%, var(--card)); border-color: var(--ok); color: var(--ok); }
.pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
.search { display: flex; gap: 8px; margin: 8px 0 14px; }
.search input { flex: 1; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--fg); font: inherit; }
.pager { display: flex; gap: 10px; margin: 14px 0; align-items: center; }
.runs { margin: 6px 0 0; padding: 0; list-style: none; font-size: 13px; }
.runs li { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; border-top: 1px dashed var(--border); }
.outcome { font-weight: 600; }
.outcome.good { color: var(--ok); } .outcome.meh { color: var(--warn); } .outcome.bad { color: var(--bad); }
.empty { color: var(--muted); padding: 24px; border: 1px dashed var(--border); border-radius: 10px; text-align: center; }
.approve { max-width: 520px; margin: 48px auto; text-align: center; }
.approve .code { font-family: var(--mono); font-size: 28px; letter-spacing: 0.1em; margin: 14px 0; }
.approve form { display: inline-flex; gap: 10px; margin-top: 18px; }
footer { margin-top: 48px; color: var(--muted); font-size: 13px; border-top: 1px solid var(--border); padding-top: 16px; }
`;

const JS = `
(function () {
  function post(method, url, body) {
    return fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: body ? JSON.stringify(body) : undefined });
  }
  function fmtRepo(r) {
    var card = document.createElement('div'); card.className = 'card';
    card.innerHTML =
      '<div class="row"><a class="name" target="_blank" rel="noopener"></a><button class="btn small toggle"></button></div>' +
      '<div class="desc"></div>' +
      '<div class="meta"><span class="lang"></span><span class="stars"></span><span class="count"></span></div>';
    var a = card.querySelector('.name'); a.textContent = r.fullName; a.href = r.htmlUrl;
    card.querySelector('.desc').textContent = r.description || '';
    card.querySelector('.lang').innerHTML = r.language ? '<span class="dot"></span>' + r.language : '';
    card.querySelector('.stars').textContent = '★ ' + r.stars;
    card.querySelector('.count').textContent = (r.selectedBy || 0) + ' user' + (r.selectedBy === 1 ? '' : 's');
    var b = card.querySelector('.toggle');
    b.dataset.owner = r.owner; b.dataset.name = r.name;
    setToggle(b, !!r.selected);
    if (!window.IDLEHAND_SIGNED_IN) b.style.display = 'none';
    return card;
  }
  function setToggle(b, on) {
    b.classList.toggle('on', on); b.dataset.on = on ? '1' : '0';
    b.textContent = on ? 'Included ✓' : 'Include';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button.toggle'); if (!b) return;
    if (!window.IDLEHAND_SIGNED_IN) { location.href = '/auth/github?next=' + encodeURIComponent(location.pathname + location.search); return; }
    var on = b.dataset.on === '1';
    b.disabled = true;
    var p = on
      ? post('DELETE', '/api/selections/' + encodeURIComponent(b.dataset.owner) + '/' + encodeURIComponent(b.dataset.name))
      : post('POST', '/api/selections', { owner: b.dataset.owner, name: b.dataset.name });
    p.then(function (res) {
      if (!res.ok) return res.json().then(function (j) { alert(j.error || ('HTTP ' + res.status)); });
      setToggle(b, !on);
      var c = b.closest('.card') && b.closest('.card').querySelector('.count');
      if (c) { var m = c.textContent.match(/\\d+/); var n = (m ? +m[0] : 0) + (on ? -1 : 1); c.textContent = n + ' user' + (n === 1 ? '' : 's'); }
    }).catch(function (err) { alert(String(err)); }).finally(function () { b.disabled = false; });
  });
  var form = document.getElementById('search-form');
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = form.querySelector('input').value.trim(); var out = document.getElementById('search-results');
    if (!q) return;
    out.innerHTML = '<div class="empty">Searching…</div>';
    fetch('/api/repos/search?q=' + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (list) {
      out.innerHTML = '';
      if (!Array.isArray(list) || !list.length) { out.innerHTML = '<div class="empty">No repositories found.</div>'; return; }
      var grid = document.createElement('div'); grid.className = 'grid';
      list.forEach(function (r) { grid.appendChild(fmtRepo(r)); });
      out.appendChild(grid);
    }).catch(function (err) { out.innerHTML = '<div class="empty">' + String(err) + '</div>'; });
  });
})();
`;

export const Layout: FC<PropsWithChildren<{ title?: string; me: Me | null }>> = ({ title, me, children }) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title ? `${title} · Idlehand` : 'Idlehand'}</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <script dangerouslySetInnerHTML={{ __html: `window.IDLEHAND_SIGNED_IN=${me ? 'true' : 'false'};` }} />
      <div class="wrap">
        <header class="top">
          <a class="brand" href="/">
            Idlehand
          </a>
          <nav>
            <a href="/popular">Popular</a>
            {me ? (
              <>
                <a href="/dashboard">Dashboard</a>
                <a href="/logout" title={`Signed in as ${me.login}`}>
                  {me.avatarUrl ? <img src={me.avatarUrl} alt="" /> : null} {me.login} · sign out
                </a>
              </>
            ) : (
              <a class="btn small" href="/auth/github">
                Sign in with GitHub
              </a>
            )}
          </nav>
        </header>
        {children}
        <footer>Idlehand spends your leftover Claude Code / Codex credits on open source. Nothing runs on this server; your machine does the work.</footer>
      </div>
      <script dangerouslySetInnerHTML={{ __html: JS }} />
    </body>
  </html>
);
