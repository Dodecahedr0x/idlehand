#!/usr/bin/env bun
import { Command } from 'commander';
import { formatBudget, parseBudget, type TaskKind } from '@idlehand/shared';
import { DEFAULT_CONFIG, getConfigValue, loadConfig, redactConfig, saveConfig, setConfigValue } from './config.ts';
import { State } from './state.ts';
import { ServerClient, ServerError } from './server.ts';
import { makeProvider } from './providers/index.ts';
import { Scheduler } from './scheduler.ts';
import { attachJson, attachPlain } from './ui/plain.ts';
import { exec, which } from './shell.ts';
import { CONFIG_PATH, HOME } from './paths.ts';

const program = new Command();
program
  .name('idlehand')
  .description('Spend your spare Claude Code / Codex credits on open source: review PRs, fix issues, hunt bugs — under a budget you set.')
  .version('0.1.0')
  .option('--json', 'machine-readable JSONL output (for agents and scripts)')
  .option('--plain', 'plain line output, no TUI');

const out = (o: unknown) => console.log(typeof o === 'string' ? o : wantsJson() ? JSON.stringify(o) : JSON.stringify(o, null, 2));
const fail = (msg: string, code = 1): never => { console.error(`error: ${msg}`); process.exit(code); };
const wantsJson = () => !!program.opts().json;

program
  .command('login')
  .description('Connect this machine to your Idlehand account (device-style flow in the browser)')
  .option('--server <url>', 'Idlehand server URL', undefined)
  .option('--no-open', 'do not try to open the browser')
  .action(async (opts: { server?: string; open: boolean }) => {
    const cfg = loadConfig();
    if (opts.server) cfg.server.url = opts.server;
    const client = new ServerClient(cfg.server.url);
    let start;
    try { start = await client.startDeviceCode(); } catch (e) { return fail(`${(e as Error).message}. Is the server running at ${cfg.server.url}? Use --server <url>.`); }
    if (wantsJson()) out({ type: 'device-code', ...start });
    else {
      console.log(`\nOpen this page and approve the code  ${start.userCode}\n\n  ${start.verificationUrl}\n`);
      if (opts.open) await openBrowser(start.verificationUrl);
      console.log('waiting for approval…');
    }
    const deadline = Date.parse(start.expiresAt);
    while (Date.now() < deadline) {
      await Bun.sleep(Math.max(2, start.interval) * 1000);
      let poll;
      try { poll = await client.pollDeviceCode(start.deviceCode); } catch (e) { if ((e as ServerError).status === 404) return fail('code was consumed or expired; run login again'); continue; }
      if (poll.status === 'approved') {
        cfg.server.token = poll.token; cfg.server.login = poll.login; saveConfig(cfg);
        return out(wantsJson() ? { type: 'logged-in', login: poll.login, server: cfg.server.url } : `✓ logged in as ${poll.login} (saved to ${CONFIG_PATH})`);
      }
      if (poll.status === 'denied') return fail('approval was denied in the browser');
      if (poll.status === 'expired') break;
    }
    fail('the code expired before it was approved; run login again');
  });

program.command('logout').description('Forget the server token on this machine').action(() => {
  const cfg = loadConfig(); cfg.server.token = null; cfg.server.login = null; saveConfig(cfg); out('✓ logged out');
});

const config = program.command('config').description('Show or change settings (stored in ~/.idlehand/config.json)');
config.command('show').description('Print the effective configuration').action(() => out(redactConfig(loadConfig())));
config.command('path').description('Print the config file path').action(() => out(CONFIG_PATH));
config
  .command('get <key>')
  .description('Print one value, e.g. `idlehand config get policy.merge`')
  .action((key: string) => { const v = getConfigValue(loadConfig(), key); if (v === undefined) fail(`unknown key ${key}`); out(v); });
config
  .command('set <key> <value>')
  .description('Set a value, e.g. `idlehand config set budget 10%`, `... set subscription.monthlyUsd 200`, `... set provider codex`, `... set policy.merge never`')
  .action((key: string, value: string) => {
    const cfg = loadConfig();
    let next;
    try { next = setConfigValue(cfg, key, value); } catch (e) { return fail((e as Error).message); }
    if (key === 'budget') { try { parseBudget(value); } catch (e) { return fail((e as Error).message); } }
    if (key === 'provider' && !['claude', 'codex'].includes(value)) return fail('provider must be claude or codex');
    saveConfig(next);
    out(wantsJson() ? { key, value: getConfigValue(next, key) } : `✓ ${key} = ${JSON.stringify(getConfigValue(next, key))}`);
  });
config.command('keys').description('List every setting with its default').action(() => {
  const flat = (o: unknown, p = ''): string[] => (o && typeof o === 'object' && !Array.isArray(o) ? Object.entries(o).flatMap(([k, v]) => flat(v, p ? `${p}.${k}` : k)) : [`${p} = ${JSON.stringify(o)}`]);
  out(flat(DEFAULT_CONFIG).join('\n'));
});

const repos = program.command('repos').description('Repos this node works on: your selections on the server plus local additions');
repos.command('list', { isDefault: true }).description('List repos (server selections + local)').action(async () => {
  const cfg = loadConfig();
  const list = await resolveRepos(cfg, []);
  out(wantsJson() ? list : list.length ? list.map((r) => `${r.source === 'server' ? '☁' : '•'} ${r.repo}`).join('\n') : 'no repos yet: select some in the web UI, or `idlehand repos add owner/name`');
});
repos.command('add <owner/name>').description('Add a repo locally (no server needed)').action((r: string) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) return fail('expected owner/name');
  const cfg = loadConfig(); if (!cfg.repos.includes(r)) cfg.repos.push(r); saveConfig(cfg); out(`✓ added ${r}`);
});
repos.command('remove <owner/name>').description('Remove a locally added repo').action((r: string) => {
  const cfg = loadConfig(); cfg.repos = cfg.repos.filter((x) => x !== r); saveConfig(cfg); out(`✓ removed ${r}`);
});

program
  .command('run')
  .description('Spend the budget: review PRs first, then open issues, then hunt for bugs in the codebase')
  .option('-b, --budget <budget>', 'e.g. "$5", "10%", "3 tasks", "45m", "remaining" (default from config)')
  .option('-p, --provider <name>', 'claude or codex (default from config)')
  .option('-r, --repo <owner/name...>', 'only these repos (otherwise: your selections + local repos)')
  .option('--only <kinds>', 'comma list of review-pr,fix-issue,review-codebase')
  .option('--once', 'stop after one task')
  .option('--dry-run', 'plan only, spend nothing')
  .option('--no-report', 'do not send run reports to the server')
  .action(async (opts: { budget?: string; provider?: string; repo?: string[]; only?: string; once?: boolean; dryRun?: boolean; report: boolean }) => {
    const cfg = loadConfig();
    let budget;
    try { budget = parseBudget(opts.budget ?? cfg.budget); } catch (e) { return fail((e as Error).message); }
    const providerName = (opts.provider ?? cfg.provider) as 'claude' | 'codex';
    if (!['claude', 'codex'].includes(providerName)) return fail('provider must be claude or codex');
    const provider = makeProvider(providerName, cfg);
    const check = await provider.check();
    if (!check.ok) return fail(check.detail);
    if (!(await which('gh'))) return fail('gh (GitHub CLI) not found; install it and run `gh auth login`');
    const ghOk = await exec(['gh', 'auth', 'status'], { timeoutMs: 20_000 });
    if (ghOk.code !== 0) return fail('gh is not logged in; run `gh auth login`');

    const only = opts.only?.split(',').map((s) => s.trim()).filter(Boolean) as TaskKind[] | undefined;
    for (const k of only ?? []) if (!['review-pr', 'fix-issue', 'review-codebase'].includes(k)) return fail(`unknown kind ${k}`);
    const list = (await resolveRepos(cfg, opts.repo ?? [])).map((r) => r.repo);
    if (list.length === 0) return fail('no repos to work on: select some in the web UI, `idlehand repos add owner/name`, or pass --repo');

    const state = new State();
    const server = cfg.server.token && opts.report ? new ServerClient(cfg.server.url, cfg.server.token) : null;
    const scheduler = new Scheduler({ repos: list, budget, cfg, provider, state, only, once: opts.once, dryRun: opts.dryRun, report: server ? (r) => server.report(r).then(() => {}) : undefined });

    const tui = process.stdout.isTTY && !program.opts().plain && !wantsJson();
    let exitCode = 0;
    if (wantsJson()) attachJson(scheduler);
    else if (!tui) attachPlain(scheduler, budget, cfg.subscription.monthlyUsd ?? undefined);
    else {
      const React = (await import('react')).default;
      const { render } = await import('ink');
      const { App } = await import('./ui/App.tsx');
      render(React.createElement(App, { scheduler, budget, provider: providerName, repos: list, subscriptionUsd: cfg.subscription.monthlyUsd ?? undefined, onExit: () => {} }));
    }
    try {
      const r = await scheduler.run();
      if (r.reports.some((x) => x.outcome === 'failed')) exitCode = 2;
    } catch (e) {
      exitCode = 1;
      console.error(`\nerror: ${(e as Error).message}`);
    } finally {
      state.close();
    }
    // Let the TUI paint its final frame.
    if (tui) await Bun.sleep(300);
    process.exit(exitCode);
  });

program
  .command('status')
  .description('What this node has done recently and spent this month')
  .option('-n <count>', 'how many recent tasks', '15')
  .action((opts: { n: string }) => {
    const cfg = loadConfig();
    const state = new State();
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const totals = state.totals(monthStart.toISOString());
    const recent = state.recent(Number(opts.n) || 15);
    state.close();
    if (wantsJson()) return out({ login: cfg.server.login, server: cfg.server.url, provider: cfg.provider, budget: cfg.budget, month: totals, recent });
    const b = parseBudget(cfg.budget);
    console.log(`idlehand · ${cfg.server.login ? `logged in as ${cfg.server.login} at ${cfg.server.url}` : 'not logged in'} · provider ${cfg.provider} · default budget ${formatBudget(b, cfg.subscription.monthlyUsd ?? undefined)}`);
    console.log(`this month: ${totals.estimated ? '≈' : ''}$${totals.spentUsd.toFixed(2)} over ${totals.tasks} task(s)`);
    if (!recent.length) return console.log('no tasks yet — run `idlehand run`');
    console.log('\nrecent:');
    for (const t of recent) console.log(`  ${t.started_at.slice(0, 16).replace('T', ' ')}  ${t.outcome.padEnd(13)} ${t.kind.padEnd(16)} ${t.repo} ${t.target}${t.url ? `  ${t.url}` : ''}  ${t.cost_estimated ? '≈' : ''}$${t.cost_usd.toFixed(2)}`);
  });

program.command('doctor').description('Check gh, the agent CLIs, and the server connection').action(async () => {
  const cfg = loadConfig();
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const ghPath = await which('gh');
  if (!ghPath) checks.push({ name: 'gh', ok: false, detail: 'not found; https://cli.github.com' });
  else {
    const st = await exec(['gh', 'auth', 'status'], { timeoutMs: 20_000 });
    checks.push({ name: 'gh', ok: st.code === 0, detail: st.code === 0 ? (st.stderr + st.stdout).split('\n').find((l) => l.includes('Logged in'))?.trim() ?? 'logged in' : 'not logged in; run `gh auth login`' });
  }
  for (const p of ['claude', 'codex'] as const) {
    const c = await makeProvider(p, cfg).check();
    checks.push({ name: p, ok: c.ok, detail: c.detail + (p === cfg.provider ? '  (selected)' : '') });
  }
  const client = new ServerClient(cfg.server.url, cfg.server.token);
  try { await client.health(); checks.push({ name: 'server', ok: true, detail: cfg.server.url }); } catch (e) { checks.push({ name: 'server', ok: false, detail: `${cfg.server.url}: ${(e as Error).message} (optional: use \`idlehand repos add\` to work without it)` }); }
  if (cfg.server.token) { try { const me = await client.me(); checks.push({ name: 'login', ok: true, detail: me.login }); } catch (e) { checks.push({ name: 'login', ok: false, detail: `token rejected: ${(e as Error).message}; run \`idlehand login\`` }); } }
  else checks.push({ name: 'login', ok: false, detail: 'not logged in (optional); run `idlehand login`' });
  let budgetOk = true, budgetDetail = cfg.budget;
  try { const b = parseBudget(cfg.budget); budgetDetail = formatBudget(b, cfg.subscription.monthlyUsd ?? undefined); if (b.kind === 'percent' && !cfg.subscription.monthlyUsd) { budgetOk = false; budgetDetail += ' — set subscription.monthlyUsd for percent budgets'; } } catch (e) { budgetOk = false; budgetDetail = (e as Error).message; }
  checks.push({ name: 'budget', ok: budgetOk, detail: budgetDetail });
  checks.push({ name: 'home', ok: true, detail: HOME });
  if (wantsJson()) return out(checks);
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name.padEnd(8)} ${c.detail}`);
  if (checks.some((c) => !c.ok && ['gh', cfg.provider, 'budget'].includes(c.name))) process.exit(1);
});

async function resolveRepos(cfg: ReturnType<typeof loadConfig>, explicit: string[]): Promise<{ repo: string; source: 'cli' | 'server' | 'local' }[]> {
  if (explicit.length) return explicit.map((repo) => ({ repo, source: 'cli' as const }));
  const seen = new Set<string>();
  const list: { repo: string; source: 'server' | 'local' }[] = [];
  if (cfg.server.token) {
    try {
      for (const r of await new ServerClient(cfg.server.url, cfg.server.token).repos()) if (!seen.has(r.fullName)) { seen.add(r.fullName); list.push({ repo: r.fullName, source: 'server' }); }
    } catch (e) {
      console.error(`warning: could not fetch selections from ${cfg.server.url}: ${(e as Error).message}`);
    }
  }
  for (const r of cfg.repos) if (!seen.has(r)) { seen.add(r); list.push({ repo: r, source: 'local' }); }
  return list;
}

async function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  await exec(cmd, { timeoutMs: 5000 }).catch(() => {});
}

program.parseAsync(process.argv).catch((e) => fail((e as Error).message));
