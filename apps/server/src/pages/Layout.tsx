import { html } from 'hono/html';
import type { FC, PropsWithChildren } from 'hono/jsx';
import type { Me } from '@idlehand/shared';

const CSS = `
:root {
  color-scheme: light;
  --bg: #f8f8f2; --fg: #213c31; --muted: #627168; --card: #fffefa; --border: #dce2d7;
  --accent: #295d43; --accent-fg: #fff; --ok: #326947; --warn: #805a20; --bad: #aa3832;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 24px; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; text-underline-offset: 4px; }
a:hover { text-decoration: underline; }
button, input { font: inherit; }
button, a, input { -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 3px solid #a36c25; outline-offset: 4px; }
[hidden] { display: none !important; }
code, pre { font-family: var(--mono); font-size: .88em; }
code { overflow-wrap: anywhere; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
h1, h2, h3, p { margin-top: 0; }
h1, h2, h3 { text-wrap: balance; }
p { text-wrap: pretty; }
h1 { font-size: clamp(32px, 4vw, 48px); letter-spacing: -.045em; line-height: 1.12; margin-bottom: 18px; font-weight: 600; }
h2 { font-size: 25px; letter-spacing: -.035em; line-height: 1.25; margin-bottom: 0; font-weight: 600; }
h3 { font-size: 17px; margin-bottom: 8px; letter-spacing: -.02em; }
.wrap { max-width: 1140px; margin: 0 auto; padding: 0 36px; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 24px 0; border-bottom: 1px solid var(--border); }
.brand { font-weight: 650; font-size: 23px; color: var(--fg); letter-spacing: -.055em; display: inline-flex; align-items: center; gap: 9px; }
.brand-mark { display: grid; place-items: center; width: 30px; height: 30px; background: var(--accent); color: #e2eead; border-radius: 50% 50% 8px 50%; font: 24px Georgia, serif; }
.top nav { display: flex; gap: 24px; align-items: center; font-size: 13px; }
.top nav > a:not(.btn) { color: var(--muted); min-height: 44px; display: inline-flex; align-items: center; }
.top nav a[aria-current=page] { color: var(--fg); font-weight: 650; text-decoration: underline; }
.account { display: flex; align-items: center; gap: 10px; border-left: 1px solid var(--border); padding-left: 20px; }
.account-name { color: var(--muted); max-width: 130px; overflow: hidden; text-overflow: ellipsis; }
.account img { width: 26px; height: 26px; border-radius: 50%; outline: 1px solid rgba(0,0,0,.1); }
.account form { margin: 0; }
.signout { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 12px; min-height: 44px; }
main { min-height: 60vh; }
.skip-link { position: absolute; top: -100px; left: 16px; background: var(--card); padding: 12px; z-index: 2; }
.skip-link:focus { top: 12px; }
.lead { font-size: 17px; color: var(--muted); max-width: 620px; margin-bottom: 24px; line-height: 1.7; }
.muted { color: var(--muted); }
.eyebrow { display: block; color: var(--muted); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; font-weight: 650; margin-bottom: 16px; }
.status-dot { width: 7px; height: 7px; background: #9fbe70; display: inline-block; border-radius: 50%; margin-right: 7px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 12px; min-height: 44px; padding: 10px 17px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--fg); cursor: pointer; font-weight: 550; font-size: 13px; line-height: 1.4; transition: background-color .16s, border-color .16s, transform .16s; }
.btn:hover { border-color: var(--accent); background: #edf0e6; text-decoration: none; }
.btn:active { transform: scale(.96); }
.btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); box-shadow: 0 2px 4px #1c38220e; }
.btn.primary:hover { background: #204b35; }
.btn.danger { color: var(--bad); }
.btn.small { padding: 8px 11px; font-size: 12px; min-height: 40px; }
.btn[disabled] { opacity: .6; cursor: wait; }
.actions { display: flex; flex-wrap: wrap; gap: 24px; align-items: center; }
.text-link { font-size: 13px; font-weight: 550; display: inline-flex; align-items: center; min-height: 44px; }
.fine-print { font-size: 12px; color: var(--muted); margin: 16px 0 0; }
.hero { display: grid; grid-template-columns: 1.15fr 1fr; gap: 70px; align-items: center; padding: 86px 0 76px; }
.hero h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 400; font-size: clamp(54px, 6.5vw, 82px); line-height: 1.03; letter-spacing: -.055em; margin-bottom: 24px; }
.hero .lead { font-size: 16px; max-width: 460px; }
.terminal { background: #20372d; color: #ecf0df; border-radius: 14px; overflow: hidden; box-shadow: 0 20px 45px -20px #20372d45, 0 1px 2px #20372d20; font-family: var(--mono); font-size: 12px; transform: rotate(-1deg); }
.terminal-bar { display: flex; gap: 20px; padding: 15px 20px; border-bottom: 1px solid #ffffff18; color: #bcc7bb; font-size: 10px; }
.terminal-dots { color: #819580; letter-spacing: 3px; }
.terminal-body { padding: 24px; }
.terminal-body p { margin-bottom: 10px; overflow-wrap: anywhere; }
.terminal-comment { color: #acbaab; font-size: 11px; }
.prompt { color: #c2da91; margin-right: 7px; }
.terminal-rule { height: 1px; background: #ffffff18; margin: 23px 0; }
.terminal-note { color: #c2da91; font-size: 10px; margin-top: 32px; }
.section { margin: 0 0 48px; scroll-margin-top: 24px; }
.section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
.section-heading .eyebrow { margin-bottom: 10px; }
.section-heading > .muted { font-size: 12px; }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; border-top: 1px solid var(--border); padding: 28px 0 12px; }
.step-number { font: 12px var(--mono); color: var(--muted); display: block; margin-bottom: 20px; }
.steps p { font-size: 13px; color: var(--muted); }
.notice { background: #edf0e5; border-radius: 10px; padding: 16px 20px; font-size: 13px; color: var(--muted); }
.notice strong { color: var(--fg); }
.notice a { text-decoration: underline; }
.page-heading { padding: 48px 0 24px; }
.page-heading .lead { margin-bottom: 0; }
.panel { background: var(--card); border-radius: 14px; padding: 28px; box-shadow: 0 0 0 1px #233b2a0c, 0 2px 5px #233b2a05; }
.setup { display: grid; grid-template-columns: 1fr 1.1fr; gap: 36px; margin-bottom: 40px; }
.setup h2 { margin-bottom: 16px; }
.checklist { margin: 0; padding: 0; list-style: none; display: grid; gap: 12px; }
.checklist li { display: flex; gap: 12px; color: var(--muted); font-size: 13px; }
.check { width: 24px; height: 24px; flex: 0 0 24px; border: 1px solid var(--border); border-radius: 50%; display: grid; place-items: center; font-size: 11px; color: var(--accent); }
.command { background: #f0f2e9; border-radius: 8px; padding: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px 0; }
.command code { font-size: 11px; }
.command .btn { flex-shrink: 0; background: var(--card); }
.setup .fine-print { margin-top: 8px; }
.section-nav { display: flex; gap: 24px; border-bottom: 1px solid var(--border); margin-bottom: 32px; }
.section-nav a { font-size: 13px; min-height: 44px; display: inline-flex; align-items: center; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); gap: 16px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.card .name { font-size: 14px; font-weight: 650; overflow-wrap: anywhere; line-height: 1.5; }
.card .desc { color: var(--muted); font-size: 13px; flex: 1; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card .meta { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--muted); align-items: center; font-variant-numeric: tabular-nums; }
.card .meta .dot { width: 7px; height: 7px; border-radius: 50%; background: #839f70; display: inline-block; margin-right: 5px; }
.card .row { display: flex; justify-content: space-between; align-items: start; gap: 14px; }
.card .toggle { flex-shrink: 0; }
.toggle.on { background: #edf3e6; border-color: #ceddc5; color: var(--ok); }
.pill { font-size: 10px; padding: 2px 7px; border-radius: 999px; background: #edf0e6; color: var(--muted); font-variant-numeric: tabular-nums; }
.search { display: flex; gap: 10px; }
.search input { flex: 1; min-width: 0; min-height: 48px; padding: 11px 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--fg); }
.search input::placeholder { color: var(--muted); opacity: 1; }
#search-status:empty { display: none; }
#search-status { font-size: 13px; margin: 16px 0; }
.pager { display: flex; gap: 12px; margin: 20px 0; align-items: center; font-size: 12px; }
.runs { margin: 0; padding: 0; list-style: none; font-size: 11px; }
.runs li { padding: 10px 0; border-top: 1px solid var(--border); }
.run-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; font-variant-numeric: tabular-nums; }
.run-summary { color: var(--muted); margin: 4px 0; }
.outcome { font-weight: 600; }
.outcome.good { color: var(--ok); } .outcome.meh { color: var(--warn); } .outcome.bad { color: var(--bad); }
.empty { color: var(--muted); padding: 32px; border: 1px dashed #bac7b3; border-radius: 12px; text-align: center; font-size: 13px; }
.empty h3 { color: var(--fg); }
.empty p:last-child { margin-bottom: 0; }
.message { max-width: 580px; margin: 64px auto; padding: 40px; }
.message h1 { font-size: 36px; }
.message .notice { margin: 24px 0 12px; }
.approve .code { font: 30px var(--mono); letter-spacing: .15em; border: 1px dashed #bac7b3; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0; }
.approve form.actions { gap: 12px; margin-top: 24px; }
.approve .search { flex-direction: column; }
.approve label { font-size: 13px; font-weight: 550; }
footer { display: flex; justify-content: space-between; gap: 32px; margin-top: 64px; border-top: 1px solid var(--border); padding: 24px 0 36px; color: var(--muted); font-size: 11px; }
footer p { max-width: 480px; margin-bottom: 0; }
footer .brand { font-size: 16px; align-self: start; }
.feedback { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--fg); color: #fff; padding: 13px 18px; border-radius: 10px; font-size: 13px; box-shadow: 0 4px 20px #213c3133; max-width: calc(100% - 32px); z-index: 5; }
.feedback:empty { display: none; }
.feedback a { color: #d3e7af; text-decoration: underline; margin-left: 8px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (max-width: 800px) {
  .hero { gap: 32px; padding: 56px 0; }
  .terminal { transform: none; }
  .hero h1 { font-size: 60px; }
  .top nav { gap: 16px; }
  .account { padding-left: 12px; }
  .account-name { display: none; }
  .setup { gap: 24px; }
}
@media (max-width: 620px) {
  .wrap { padding: 0 20px; }
  .top { flex-wrap: wrap; gap: 12px; padding: 18px 0; }
  .brand { font-size: 21px; }
  .top nav { gap: 12px; flex-wrap: wrap; }
  .top nav .btn { padding: 8px 10px; }
  .account { padding-left: 8px; gap: 4px; }
  .account img { display: none; }
  .hero { grid-template-columns: 1fr; padding: 44px 0; gap: 36px; }
  .hero h1 { font-size: 64px; }
  .hero .lead { max-width: none; }
  .terminal-body { padding: 22px; }
  .steps { grid-template-columns: 1fr; gap: 16px; }
  .steps article { display: grid; grid-template-columns: 28px 1fr; column-gap: 12px; }
  .steps .step-number { grid-row: span 2; margin-top: 4px; }
  .steps p { margin-bottom: 0; }
  .section-heading { align-items: start; flex-direction: column; gap: 10px; }
  .section-heading .text-link { min-height: 32px; }
  .section { margin-bottom: 36px; }
  .setup { grid-template-columns: 1fr; padding: 20px; }
  .section-nav { gap: 18px; }
  .search { flex-wrap: wrap; }
  .search input { flex-basis: 100%; }
  .search .btn { width: 100%; }
  .message { margin: 36px auto; padding: 24px; }
  .message h1 { font-size: 32px; }
  .btn.small { min-height: 44px; }
  footer { margin-top: 48px; flex-direction: column; gap: 12px; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } .btn { transition: none; } .btn:active { transform: none; } }
`;

const JS = `
(function () {
  var signedIn = document.body.dataset.signedIn === 'true';
  var feedback = document.getElementById('feedback');
  function announce(message, signIn) {
    feedback.replaceChildren(document.createTextNode(message));
    if (signIn) {
      var a = document.createElement('a'); a.textContent = 'Sign in again';
      a.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); feedback.appendChild(a);
    }
  }
  function setToggle(b, on) {
    b.classList.toggle('on', on); b.dataset.on = on ? '1' : '0';
    b.textContent = on ? 'Included ✓' : 'Include +'; b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', (on ? 'Remove ' : 'Include ') + b.dataset.owner + '/' + b.dataset.name);
  }
  function key(b) { return (b.dataset.owner + '/' + b.dataset.name).toLowerCase(); }
  function fmtRepo(r) {
    var card = document.createElement('article'); card.className = 'card';
    card.dataset.repo = r.fullName.toLowerCase();
    card.innerHTML = '<div class="row"><a class="name" target="_blank" rel="noopener"></a><button type="button" class="btn small toggle"></button></div><div class="desc"></div><div class="meta"><span class="lang"></span><span class="stars"></span><span class="count"></span><span class="pill privacy" hidden>Private</span></div>';
    var a = card.querySelector('.name'); a.textContent = r.fullName; a.href = r.htmlUrl;
    card.querySelector('.desc').textContent = r.description || 'No description provided.';
    card.querySelector('.lang').textContent = r.language || '';
    card.querySelector('.stars').textContent = '☆ ' + r.stars.toLocaleString();
    setCount(card, r.selectedBy || 0);
    card.querySelector('.privacy').hidden = !r.private;
    var b = card.querySelector('.toggle'); b.dataset.owner = r.owner; b.dataset.name = r.name;
    setToggle(b, !!r.selected);
    if (!signedIn) {
      var link = document.createElement('a'); link.className = 'btn small'; link.textContent = 'Include +';
      link.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); b.replaceWith(link);
    }
    return card;
  }
  function setCount(card, n) {
    var count = card.querySelector('.count'); count.dataset.count = String(n);
    count.textContent = 'Included by ' + n;
  }
  function syncSelection(repoKey, on, repo) {
    document.querySelectorAll('.card').forEach(function (card) {
      if (card.dataset.repo !== repoKey) return;
      var n = Number(card.querySelector('.count').dataset.count || 0);
      setCount(card, repo ? repo.selectedBy : Math.max(0, n - 1));
      var b = card.querySelector('.toggle'); if (b) setToggle(b, on);
    });
    var grid = document.getElementById('included-grid');
    if (!grid) return;
    var existing = Array.from(grid.children).find(function (c) { return c.dataset.repo === repoKey; });
    if (!on && existing) existing.remove();
    if (on && !existing && repo) grid.prepend(fmtRepo(repo));
    var n = grid.children.length;
    document.getElementById('included-empty').hidden = n > 0;
    document.getElementById('included-count').textContent = n;
    document.getElementById('choose-step').textContent = n ? '✓' : '1';
  }
  document.addEventListener('click', async function (e) {
    var copy = e.target.closest('button[data-copy]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); announce('Command copied. Paste it into your terminal.'); }
      catch (_) { announce('Copy is unavailable. Select the command and copy it manually.'); }
      return;
    }
    var b = e.target.closest('button.toggle'); if (!b || b.disabled) return;
    var repoKey = key(b), on = b.dataset.on === '1', restoreFocus = b === document.activeElement;
    var buttons = Array.from(document.querySelectorAll('button.toggle')).filter(function (t) { return key(t) === repoKey; });
    buttons.forEach(function (t) { t.disabled = true; t.setAttribute('aria-busy', 'true'); });
    try {
      var url = on ? '/api/selections/' + encodeURIComponent(b.dataset.owner) + '/' + encodeURIComponent(b.dataset.name) : '/api/selections';
      var res = await fetch(url, { method: on ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: on ? undefined : JSON.stringify({ owner: b.dataset.owner, name: b.dataset.name }) });
      if (res.status === 401) { announce('Your session has ended. Your saved repositories are safe.', true); return; }
      if (!res.ok) { announce('Could not save this change. Please try again.'); return; }
      var repo = on ? null : await res.json(); syncSelection(repoKey, !on, repo);
      announce(b.dataset.owner + '/' + b.dataset.name + (on ? ' removed from your list.' : ' included. Your next run will pick it up.'));
    } catch (_) { announce('Could not reach Idlehand. Check your connection and try again.'); }
    finally {
      buttons.forEach(function (t) { t.disabled = false; t.removeAttribute('aria-busy'); });
      if (restoreFocus) {
        var target = document.contains(b) ? b : Array.from(document.querySelectorAll('button.toggle')).find(function (t) { return key(t) === repoKey; });
        if (target) target.focus();
        else { var search = document.getElementById('repo-search'); if (search) search.focus(); }
      }
    }
  });
  var form = document.getElementById('search-form'), searchController;
  if (form) form.addEventListener('submit', async function (e) {
    e.preventDefault(); var input = form.querySelector('input'), q = input.value.trim();
    if (!q) { input.focus(); return; }
    if (searchController) searchController.abort();
    var controller = new AbortController(); searchController = controller;
    var out = document.getElementById('search-results'), status = document.getElementById('search-status');
    var button = form.querySelector('button'); button.textContent = 'Searching…';
    out.setAttribute('aria-busy', 'true'); status.textContent = 'Searching GitHub…'; out.replaceChildren();
    try {
      var res = await fetch('/api/repos/search?q=' + encodeURIComponent(q), { signal: controller.signal });
      if (!res.ok) throw new Error('search');
      var list = await res.json(); if (!Array.isArray(list)) throw new Error('search');
      if (controller.signal.aborted) return;
      status.textContent = list.length ? list.length + ' repositories found for “' + q + '”.' : 'No repositories found for “' + q + '”. Try another name or owner.';
      var grid = document.createElement('div'); grid.className = 'grid';
      list.forEach(function (r) { grid.appendChild(fmtRepo(r)); }); out.replaceChildren(grid);
    } catch (err) {
      if (controller.signal.aborted) return;
      status.textContent = 'GitHub search is unavailable. Check your connection or try again in a moment. Your saved repositories are unchanged.';
    } finally {
      if (searchController === controller) { out.removeAttribute('aria-busy'); button.innerHTML = 'Search GitHub <span aria-hidden="true">→</span>'; }
    }
  });
  document.querySelectorAll('.approve form[method="post"]').forEach(function (form) {
    form.addEventListener('submit', function () {
      form.setAttribute('aria-busy', 'true');
      setTimeout(function () { form.querySelectorAll('button').forEach(function (b) { b.disabled = true; }); }, 0);
    });
  });
})();
`;

export const Layout: FC<PropsWithChildren<{ title?: string; me: Me | null; active?: 'dashboard' | 'popular' }>> = ({ title, me, active, children }) => html`<!DOCTYPE html>${(
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="description" content="Put your leftover Claude Code or Codex credits to work on open source. Choose repositories, set a budget, and contribute from your own machine." />
      <meta name="theme-color" content="#f8f8f2" />
      <link rel="icon" href={`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="12" fill="#295d43"/><text x="16" y="24" text-anchor="middle" font-family="Georgia,serif" font-size="27" fill="#e2eead">i</text></svg>')}`} />
      <title>{title ? `${title} · Idlehand` : 'Idlehand — good code from idle time'}</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body data-signed-in={me ? 'true' : 'false'}>
      <a class="skip-link" href="#main">Skip to content</a>
      <div class="wrap">
        <header class="top">
          <a class="brand" href="/" aria-label="Idlehand home"><span class="brand-mark" aria-hidden="true">i</span>idlehand</a>
          <nav aria-label="Main navigation">
            <a href="/popular" aria-current={active === 'popular' ? 'page' : undefined}>Explore</a>
            {me ? <>
              <a href="/dashboard" aria-current={active === 'dashboard' ? 'page' : undefined}>Dashboard</a>
              <div class="account">
                {me.avatarUrl ? <img src={me.avatarUrl} alt="" width={26} height={26} /> : null}
                <span class="account-name">{me.login}</span>
                <form method="post" action="/logout"><button class="signout" type="submit" aria-label={`Sign out of ${me.login}`}>Sign out</button></form>
              </div>
            </> : <a class="btn small" href="/login">Sign in with GitHub <span aria-hidden="true">↗</span></a>}
          </nav>
        </header>
        <main id="main" tabindex={-1}>{children}</main>
        <footer><a class="brand" href="/">idlehand</a><p>A little of your idle time. A little better open source.<br />Your machine does the work. You set the limits.</p><a class="text-link" href="/popular">Find a project ↗</a></footer>
      </div>
      <div id="feedback" class="feedback" role="status" aria-live="polite" aria-atomic="true" />
      <script dangerouslySetInnerHTML={{ __html: JS }} />
    </body>
  </html>
)}`;
