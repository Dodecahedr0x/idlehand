import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../config.ts';
import { ClaudeProvider } from './claude.ts';
import { CodexProvider } from './codex.ts';
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
  const result = await new ClaudeProvider(f.cfg.claude).run({ ...f.request, timeoutMs: 300 });
  expect(result.costUsd).toBe(0.005);
  expect(result.error).toContain('timed out');
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
