#!/usr/bin/env bun
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { checkBudget, formatBudget, formatCost, parseBudget, usdCap, type TaskKind } from '@idlehand/shared';
import { DEFAULT_CONFIG, getConfigValue, loadConfig, redactConfig, saveConfig, setConfigValue } from './config.ts';
import { State } from './state.ts';
import { ServerClient, ServerError } from './server.ts';
import { makeProvider, providerBudgetError } from './providers/index.ts';
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
  .option('--plain', 'plain line output, no TUI')
  .showSuggestionAfterError()
  .exitOverride()
  .configureOutput({ writeErr: () => {} })
  .addHelpText('after', `
Quick start:
  idlehand doctor                         Check your setup
  idlehand repos add owner/name           Pick a repository (no server needed)
  idlehand run --dry-run                   Preview the work without spending credits
  idlehand run --provider claude --budget '$2' --once   Try one task with a $2 stopping threshold

Use idlehand login to sync repository selections from the web.
Quote dollar budgets with single quotes so your shell preserves the $ sign.
Claude dollar thresholds can overshoot during in-flight calls. Codex needs a task, time, or remaining budget.
Output switches to plain text when piped. Use --json for JSONL.
Exit codes: 0 success, 1 setup or command error, 2 one or more tasks failed.`);

const out = (o: unknown) => console.log(wantsJson() ? JSON.stringify(o) : typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const fail = (msg: string): never => { throw new Error(msg); };
const wantsJson = () => !!program.opts().json;
const warn = (message: string) => console.error(wantsJson() ? JSON.stringify({ type: 'warning', message }) : `warning: ${message}`);
const repoName = (value: string): string => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(value) || value.split('/').some((part) => part === '.' || part === '..')) {
    throw new InvalidArgumentError('expected owner/name, for example: idlehand repos add honojs/hono');
  }
  return value;
};
const taskKinds = (value: string): TaskKind[] => {
  const kinds = value.split(',').map((s) => s.trim());
  if (kinds.some((k) => !['review-pr', 'fix-issue', 'review-codebase'].includes(k))) {
    throw new InvalidArgumentError('use review-pr, fix-issue, review-codebase, or a comma-separated combination');
  }
  return [...new Set(kinds)] as TaskKind[];
};

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
  const cfg = loadConfig(); cfg.server.token = null; cfg.server.login = null; saveConfig(cfg); out(wantsJson() ? { type: 'logged-out' } : '✓ logged out');
});

const config = program.command('config').description('Show or change settings (stored in ~/.idlehand/config.json)')
  .addHelpText('after', `
Examples:
  idlehand config                         Show current settings (token redacted)
  idlehand config set provider codex
  idlehand config set budget '$5'
  idlehand config set subscription.monthlyUsd 200
  idlehand config set policy.merge never
  idlehand config keys                    List available settings`);
config.command('show', { isDefault: true }).description('Print the effective configuration').action(() => out(redactConfig(loadConfig())));
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
  out(wantsJson() ? DEFAULT_CONFIG : flat(DEFAULT_CONFIG).join('\n'));
});

const repos = program.command('repos').description('Repos this node works on: your selections on the server plus local additions')
  .addHelpText('after', `
Examples:
  idlehand repos                          List server selections and local repos
  idlehand repos add honojs/hono           Add a local selection
  idlehand repos remove honojs/hono        Remove a local selection

Manage server selections in the web UI. Removing a local selection keeps any server selection.`);
repos.command('list', { isDefault: true }).description('List repos (server selections + local)').action(async () => {
  const cfg = loadConfig();
  const list = await resolveRepos(cfg, []);
  out(wantsJson() ? list : list.length ? list.map((r) => `${r.source === 'server' ? '☁' : '•'} ${r.repo}`).join('\n') : 'no repos yet: select some in the web UI, or `idlehand repos add owner/name`');
});
repos.command('add').argument('<owner/name>', 'GitHub repository', repoName).description('Add a repo locally (no server needed)').action((r: string) => {
  const cfg = loadConfig();
  const added = !cfg.repos.includes(r);
  if (added) { cfg.repos.push(r); saveConfig(cfg); }
  out(wantsJson() ? { repo: r, added } : added ? `✓ added ${r}` : `${r} is already selected locally`);
});
repos.command('remove').argument('<owner/name>', 'GitHub repository', repoName).description('Remove a locally added repo').action((r: string) => {
  const cfg = loadConfig();
  const removed = cfg.repos.includes(r);
  if (removed) { cfg.repos = cfg.repos.filter((x) => x !== r); saveConfig(cfg); }
  out(wantsJson() ? { repo: r, removed } : removed ? `✓ removed ${r} locally; server selections are unchanged` : `${r} is not selected locally; manage server selections in the web UI`);
});

program
  .command('run')
  .description('Spend the budget: review PRs first, then open issues, then hunt for bugs in the codebase')
  .option('-b, --budget <budget>', "e.g. '$5', '10%', '3 tasks', '45m', 'remaining' (default from config)")
  .addOption(new Option('-p, --provider <name>', 'agent to use (default from config)').choices(['claude', 'codex']))
  .option('-r, --repo <owner/name...>', 'only these repos (otherwise: your selections + local repos)', (value: string, previous: string[] = []) => [...previous, repoName(value)])
  .option('--only <kinds>', 'comma list of review-pr,fix-issue,review-codebase', taskKinds)
  .option('--once', 'stop after one task')
  .option('--dry-run', 'plan only, spend nothing')
  .option('--no-report', 'do not send run reports to the server')
  .addHelpText('after', `
Examples:
  idlehand run --dry-run --repo honojs/hono
  idlehand run --provider claude --budget '$2' --once
  idlehand run --provider codex --budget '3 tasks' --only fix-issue
  idlehand run --provider claude --budget 10%   Requires subscription.monthlyUsd
  idlehand run --json --budget 45m > run.jsonl

Ctrl+C or q in the dashboard stops after the current task finishes.
Claude dollar thresholds can overshoot during in-flight calls. Codex has no dollar cap.
Dry runs need gh login, but do not need an agent CLI or change saved task records.`)
  .action(async (opts: { budget?: string; provider?: string; repo?: string[]; only?: TaskKind[]; once?: boolean; dryRun?: boolean; report: boolean }) => {
    const cfg = loadConfig();
    let budget;
    try { budget = parseBudget(opts.budget ?? cfg.budget); } catch (e) { return fail((e as Error).message); }
    const ready = checkBudget(budget, { spentUsd: 0, tasksCompleted: 0, elapsedMs: 0, providerExhausted: false }, cfg.subscription.monthlyUsd ?? undefined);
    if (!ready.ok) return fail(ready.reason);
    const providerName = (opts.provider ?? cfg.provider) as 'claude' | 'codex';
    if (!['claude', 'codex'].includes(providerName)) return fail('provider must be claude or codex');
    const provider = makeProvider(providerName, cfg);
    if (!opts.dryRun) {
      const budgetError = providerBudgetError(provider, usdCap(budget, cfg.subscription.monthlyUsd ?? undefined));
      if (budgetError) return fail(budgetError);
      const check = await provider.check();
      if (!check.ok) return fail(`${check.detail}. Run idlehand doctor to check your setup.`);
    }
    if (!(await which('gh'))) return fail('gh (GitHub CLI) not found; install it and run `gh auth login`');
    const ghOk = await exec(['gh', 'auth', 'status'], { timeoutMs: 20_000 });
    if (ghOk.code !== 0) return fail('gh is not logged in; run `gh auth login`');

    const only = opts.only;
    const list = (await resolveRepos(cfg, opts.repo ?? [])).map((r) => r.repo);
    if (list.length === 0) return fail('no repos to work on: select some in the web UI, `idlehand repos add owner/name`, or pass --repo');

    const state = new State();
    const server = cfg.server.token && opts.report ? new ServerClient(cfg.server.url, cfg.server.token) : null;
    const scheduler = new Scheduler({ repos: list, budget, cfg, provider, state, only, once: opts.once, dryRun: opts.dryRun, report: server ? (r) => server.report(r).then(() => {}) : undefined });

    const tui = process.stdin.isTTY && process.stdout.isTTY && !program.opts().plain && !wantsJson();
    let exitCode = 0;
    let unmount: (() => void) | undefined;
    const stop = () => scheduler.stop();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      if (wantsJson()) attachJson(scheduler);
      else if (!tui) attachPlain(scheduler, budget, cfg.subscription.monthlyUsd ?? undefined);
      else {
        const React = (await import('react')).default;
        const { render } = await import('ink');
        const { App } = await import('./ui/App.tsx');
        await new Promise<void>((onReady) => {
          const instance = render(React.createElement(App, { scheduler, budget, provider: providerName, repos: list, subscriptionUsd: cfg.subscription.monthlyUsd ?? undefined, onReady }), { exitOnCtrlC: false });
          unmount = instance.unmount;
        });
      }
      const r = await scheduler.run();
      if (r.reports.some((x) => x.outcome === 'failed')) exitCode = 2;
    } finally {
      if (tui) await Bun.sleep(150);
      unmount?.();
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      state.close();
    }
    process.exitCode = exitCode;
  });

program
  .command('status')
  .description('What this node has done recently and spent this month')
  .option('-n, --limit <count>', 'how many recent tasks', (value: string) => {
    const count = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count < 1) throw new InvalidArgumentError('expected a positive whole number, for example: idlehand status --limit 5');
    return count;
  }, 15)
  .action((opts: { limit: number }) => {
    const cfg = loadConfig();
    const state = new State();
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const totals = state.totals(monthStart.toISOString());
    const recent = state.recent(opts.limit);
    state.close();
    if (wantsJson()) return out({ login: cfg.server.login, server: cfg.server.url, provider: cfg.provider, budget: cfg.budget, month: totals, recent });
    const b = parseBudget(cfg.budget);
    console.log(`idlehand · ${cfg.server.login ? `logged in as ${cfg.server.login} at ${cfg.server.url}` : 'not logged in'} · provider ${cfg.provider} · default budget ${formatBudget(b, cfg.subscription.monthlyUsd ?? undefined)}`);
    console.log(`this month: ${formatCost(totals.spentUsd, totals.estimated, totals.costUnknown)} over ${totals.tasks} task(s)`);
    if (!recent.length) return console.log('no tasks yet — run `idlehand run`');
    console.log('\nrecent:');
    for (const t of recent) console.log(`  ${t.started_at.slice(0, 16).replace('T', ' ')}  ${t.outcome.padEnd(13)} ${t.kind.padEnd(16)} ${t.repo} ${t.target}${t.url ? `  ${t.url}` : ''}  ${formatCost(t.cost_usd, !!t.cost_estimated, !!t.cost_unknown)}`);
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
  try {
    const b = parseBudget(cfg.budget);
    const ready = checkBudget(b, { spentUsd: 0, tasksCompleted: 0, elapsedMs: 0, providerExhausted: false }, cfg.subscription.monthlyUsd ?? undefined);
    budgetOk = ready.ok;
    budgetDetail = ready.ok ? formatBudget(b, cfg.subscription.monthlyUsd ?? undefined) : ready.reason;
    if (ready.ok) {
      const budgetError = providerBudgetError(makeProvider(cfg.provider, cfg), usdCap(b, cfg.subscription.monthlyUsd ?? undefined));
      if (budgetError) { budgetOk = false; budgetDetail = budgetError; }
    }
  } catch (e) { budgetOk = false; budgetDetail = (e as Error).message; }
  checks.push({ name: 'budget', ok: budgetOk, detail: budgetDetail });
  checks.push({ name: 'home', ok: true, detail: HOME });
  if (wantsJson()) out(checks);
  else for (const c of checks) console.log(`${c.ok ? '✓' : ['gh', cfg.provider, 'budget'].includes(c.name) ? '✗' : '–'} ${c.name.padEnd(8)} ${c.detail}`);
  if (checks.some((c) => !c.ok && ['gh', cfg.provider, 'budget'].includes(c.name))) process.exitCode = 1;
});

async function resolveRepos(cfg: ReturnType<typeof loadConfig>, explicit: string[]): Promise<{ repo: string; source: 'cli' | 'server' | 'local' }[]> {
  if (explicit.length) return [...new Set(explicit)].map((repo) => ({ repo, source: 'cli' as const }));
  const seen = new Set<string>();
  const list: { repo: string; source: 'server' | 'local' }[] = [];
  if (cfg.server.token) {
    try {
      for (const r of await new ServerClient(cfg.server.url, cfg.server.token).repos()) if (!seen.has(r.fullName)) { seen.add(r.fullName); list.push({ repo: r.fullName, source: 'server' }); }
    } catch (e) {
      warn(`could not fetch selections from ${cfg.server.url}: ${(e as Error).message}. Check idlehand login or pass --repo owner/name.`);
    }
  }
  for (const r of cfg.repos) if (!seen.has(r)) { seen.add(r); list.push({ repo: r, source: 'local' }); }
  return list;
}

async function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  await exec(cmd, { timeoutMs: 5000 }).catch(() => {});
}

if (process.argv.slice(2).every((arg) => ['--plain', '--json'].includes(arg))) program.outputHelp();
else program.parseAsync(process.argv).catch((e: Error) => {
  if (e instanceof CommanderError && e.exitCode === 0) return;
  const message = e.message.replace(/^error: /, '');
  // Commander can reject an argument before it has parsed the global options.
  const json = wantsJson() || process.argv.slice(2).includes('--json');
  console.error(json ? JSON.stringify({ type: 'error', message }) : `error: ${message}`);
  if (!json && e instanceof CommanderError) console.error('Run idlehand <command> --help for usage and examples.');
  process.exitCode = 1;
});
