import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../config.ts';
import { ClaudeProvider } from './claude.ts';
import { CodexProvider } from './codex.ts';
import { CursorProvider } from './cursor.ts';
import type { AgentRunRequest } from './types.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), 'idlehand-provider-budget-'));
  roots.push(root);
  const bin = join(root, 'fake-provider');
  const calls = join(root, 'calls.json');
  writeFileSync(bin, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));\n${script}\n`, { mode: 0o755 });
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.claude.bin = bin;
  cfg.codex.bin = bin;
  cfg.cursor.bin = bin;
  const request: AgentRunRequest = { cwd: root, prompt: 'fixture', schema: { type: 'object' }, maxBudgetUsd: 0.01, timeoutMs: 2000, onLog: () => {} };
  return { cfg, request, calls };
}

const claudeResult = (over: Record<string, unknown> = {}) => JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.001, structured_output: { ok: true }, ...over });

test('Codex refuses any dollar threshold without starting the process', async () => {
  const f = fixture('throw new Error("must never run");');
  for (const cap of [0.01, 10, 0, -1, Infinity, NaN]) {
    const result = await new CodexProvider(f.cfg.codex).run({ ...f.request, maxBudgetUsd: cap });
    expect(result.error).toContain(cap > 0 && Number.isFinite(cap) ? 'Codex cannot enforce' : 'positive finite');
    expect(result.costUsd).toBe(0);
    expect(existsSync(f.calls)).toBe(false);
  }
});

test('Claude passes fractional-cent thresholds unchanged and rejects invalid limits before spawning', async () => {
  const f = fixture(`process.stdout.write('null\\n42\\n[]\\n'); process.stdout.write(${JSON.stringify(claudeResult())});`);
  const provider = new ClaudeProvider(f.cfg.claude);
  for (const cap of [0, -1, Infinity, NaN]) {
    expect((await provider.run({ ...f.request, maxBudgetUsd: cap })).error).toContain('positive finite');
    expect(existsSync(f.calls)).toBe(false);
  }
  for (const cap of [0.01, 0.0049]) {
    const result = await provider.run({ ...f.request, maxBudgetUsd: cap });
    expect(result.error).toBeNull();
    const args = JSON.parse(readFileSync(f.calls, 'utf8')) as string[];
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe(String(cap));
    expect(result.costUsd).toBe(0.001);
    expect(result.costEstimated).toBe(true);
    expect(result.costUnknown).toBe(false);
  }
});

test('Claude retains charged usage and refuses successful output after an overshoot or failed exit', async () => {
  const overrun = fixture(`process.stdout.write(${JSON.stringify(claudeResult({ total_cost_usd: 1.25 }))});`);
  const result = await new ClaudeProvider(overrun.cfg.claude).run(overrun.request);
  expect(result.costUsd).toBe(1.25);
  expect(result.error).toContain('in-flight usage');
  const failed = fixture(`process.stdout.write(${JSON.stringify(claudeResult({ total_cost_usd: 0.005 }))}); process.exitCode = 1;`);
  const failure = await new ClaudeProvider(failed.cfg.claude).run(failed.request);
  expect(failure.costUsd).toBe(0.005);
  expect(failure.error).toContain('exited 1');
});

test('Claude marks missing or invalid accounting unknown rather than treating a run as free', async () => {
  for (const cost of [undefined, -1, '0.01']) {
    const f = fixture(`process.stdout.write(${JSON.stringify(claudeResult({ total_cost_usd: cost }))});`);
    const result = await new ClaudeProvider(f.cfg.claude).run(f.request);
    expect(result.costUnknown).toBe(true);
    expect(result.error).toContain('usage is unknown');
  }
});

test('Claude keeps a reported charge when the process later times out', async () => {
  const f = fixture(`console.log(${JSON.stringify(claudeResult({ total_cost_usd: 0.005 }))}); await Bun.sleep(10000);`);
  const result = await new ClaudeProvider(f.cfg.claude).run({ ...f.request, timeoutMs: 1500 });
  expect(result.costUsd).toBe(0.005);
  expect(result.error).toContain('timed out');
});

const cursorResult = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: '{"ok":true}', session_id: 'sess-1',
  usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ...over,
});

test('Cursor refuses any dollar threshold without starting the process', async () => {
  const f = fixture('throw new Error("must never run");');
  for (const cap of [0.01, 10, 0, -1, Infinity, NaN]) {
    const result = await new CursorProvider(f.cfg.cursor).run({ ...f.request, maxBudgetUsd: cap });
    expect(result.error).toContain(cap > 0 && Number.isFinite(cap) ? 'Cursor cannot enforce' : 'positive finite');
    expect(result.costUsd).toBe(0);
    expect(existsSync(f.calls)).toBe(false);
  }
});

test('Cursor trusts the workspace, appends the schema, and prices reported tokens', async () => {
  const events = [
    { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'Composer' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the repo' }] } },
    { type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'bun test' } } } },
    JSON.parse(cursorResult({ usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 } })),
  ].map((ev) => JSON.stringify(ev)).join('\n');
  const logs: string[] = [];
  const f = fixture(`process.stdout.write(${JSON.stringify(events)});`);
  f.cfg.cursor.model = 'composer-2';
  const result = await new CursorProvider(f.cfg.cursor).run({ ...f.request, maxBudgetUsd: null, schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, onLog: (line) => logs.push(line) });
  expect(result.error).toBeNull();
  expect(result.output).toEqual({ ok: true });
  expect(result.costUsd).toBe(3 + 15 + 0.3 + 3.75);
  expect(result.costEstimated).toBe(true);
  expect(result.costUnknown).toBe(false);
  expect(result.sessionId).toBe('sess-1');
  const args = JSON.parse(readFileSync(f.calls, 'utf8')) as string[];
  expect(args).toContain('--print');
  expect(args).toContain('--force');
  expect(args).toContain('--trust');
  expect(args[args.indexOf('--workspace') + 1]).toBe(f.request.cwd);
  expect(args[args.indexOf('--model') + 1]).toBe('composer-2');
  expect(args.at(-1)).toContain('"properties":{"ok":{"type":"boolean"}}');
  expect(logs.some((line) => line.includes('shell bun test'))).toBe(true);
  expect(logs.some((line) => line.startsWith('💬 Reading'))).toBe(true);
});

test('Cursor marks missing or invalid token usage unknown and keeps a reported estimate after failure', async () => {
  const missing = fixture(`process.stdout.write(${JSON.stringify(cursorResult({ usage: undefined }))});`);
  const unknown = await new CursorProvider(missing.cfg.cursor).run({ ...missing.request, maxBudgetUsd: null });
  expect(unknown.costUnknown).toBe(true);
  expect(unknown.error).toContain('usage is unknown');
  const invalid = fixture(`process.stdout.write(${JSON.stringify(cursorResult({ usage: { inputTokens: -1, outputTokens: 1 } }))});`);
  expect((await new CursorProvider(invalid.cfg.cursor).run({ ...invalid.request, maxBudgetUsd: null })).costUnknown).toBe(true);
  const failed = fixture(`process.stdout.write(${JSON.stringify(cursorResult())}); process.exitCode = 1;`);
  const failure = await new CursorProvider(failed.cfg.cursor).run({ ...failed.request, maxBudgetUsd: null });
  expect(failure.costUsd).toBe(3);
  expect(failure.costUnknown).toBe(true);
  expect(failure.error).toContain('exited 1');
  const prices = fixture('throw new Error("must never run");');
  prices.cfg.cursor.pricing.outputPerM = Number.NaN;
  expect((await new CursorProvider(prices.cfg.cursor).run({ ...prices.request, maxBudgetUsd: null })).error).toContain('token prices');
  expect(existsSync(prices.calls)).toBe(false);
});

test('uncapped Codex prices trailing completed-turn usage without requiring a final newline', async () => {
  const events = [
    { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } },
    { type: 'turn.completed', usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 } },
  ].map((ev) => JSON.stringify(ev)).join('\n');
  const f = fixture(`process.stdout.write('null\\n42\\n[]\\n'); process.stdout.write(${JSON.stringify(events)});`);
  const result = await new CodexProvider(f.cfg.codex).run({ ...f.request, maxBudgetUsd: null });
  expect(result.error).toBeNull();
  expect(result.costUsd).toBe(1.25);
  expect(result.costEstimated).toBe(true);
  expect(result.costUnknown).toBe(false);
  expect(result.output).toEqual({ ok: true });
});

test('providers resume the saved session instead of repeating the original prompt', async () => {
  const claude = fixture(`process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-9' }) + '\n' + claudeResult({ session_id: 'sess-9' }))});`);
  let claudeSession = '';
  await new ClaudeProvider(claude.cfg.claude).run({ ...claude.request, resumeSessionId: 'sess-9', onSession: (id) => { claudeSession = id; } });
  const claudeArgs = JSON.parse(readFileSync(claude.calls, 'utf8')) as string[];
  expect(claudeArgs[claudeArgs.indexOf('--resume') + 1]).toBe('sess-9');
  expect(claudeArgs[1]).toContain('interrupted');
  expect(claudeArgs).not.toContain('fixture');
  expect(claudeSession).toBe('sess-9');

  const codex = fixture('process.stdout.write(' + JSON.stringify(JSON.stringify({ type: 'thread.started', thread_id: 'thr-1' }) + '\n') + ');');
  await new CodexProvider(codex.cfg.codex).run({ ...codex.request, maxBudgetUsd: null, resumeSessionId: 'thr-1' });
  const codexArgs = JSON.parse(readFileSync(codex.calls, 'utf8')) as string[];
  expect(codexArgs.slice(0, 2)).toEqual(['exec', 'resume']);
  expect(codexArgs.at(-2)).toBe('thr-1');
  expect(codexArgs.at(-1)).toContain('interrupted');

  const cursor = fixture(`process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'chat-1' }) + '\n' + cursorResult({ session_id: 'chat-1' }))});`);
  let cursorSession = '';
  await new CursorProvider(cursor.cfg.cursor).run({ ...cursor.request, maxBudgetUsd: null, resumeSessionId: 'chat-1', onSession: (id) => { cursorSession = id; } });
  const cursorArgs = JSON.parse(readFileSync(cursor.calls, 'utf8')) as string[];
  expect(cursorArgs[cursorArgs.indexOf('--resume') + 1]).toBe('chat-1');
  expect(cursorArgs.at(-1)).toContain('interrupted');
  expect(cursorSession).toBe('chat-1');
});

test('uncapped Codex preserves completed-turn usage when later turns fail and marks final cost unknown', async () => {
  const events = [
    { type: 'turn.completed', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    { type: 'turn.failed', error: { message: 'connection lost' } },
  ].map((ev) => JSON.stringify(ev)).join('\n');
  const f = fixture(`process.stdout.write(${JSON.stringify(events)});`);
  const result = await new CodexProvider(f.cfg.codex).run({ ...f.request, maxBudgetUsd: null });
  expect(result.error).toContain('connection lost');
  expect(result.costUsd).toBe(1.25);
  expect(result.costUnknown).toBe(true);
});
