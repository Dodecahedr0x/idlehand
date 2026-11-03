import { formatCost } from '@idlehand/shared';
import type { Config } from '../config.ts';
import { exec, tail, which } from '../shell.ts';
import { EXHAUSTED_RE, agentPrompt, extractJson, noteSession, providerBudgetError, refusedRun, type AgentProvider, type AgentRunRequest, type AgentRunResult } from './types.ts';

/**
 * Cursor CLI in headless mode: `agent -p --output-format stream-json`.
 * stdout is NDJSON. The terminal `result` event carries the assistant text
 * and token `usage`. The CLI has no dollar stopping threshold and no JSON
 * schema flag, so the schema is appended to the prompt and cost is estimated.
 */
export class CursorProvider implements AgentProvider {
  readonly name = 'cursor' as const;
  readonly supportsUsdBudget = false;
  constructor(private cfg: Config['cursor']) {}

  async check() {
    const path = await which(this.cfg.bin);
    if (!path) return { ok: false, detail: `${this.cfg.bin} not found on PATH (install the Cursor CLI: https://cursor.com/docs/cli/overview)` };
    const r = await exec([this.cfg.bin, '--version'], { timeoutMs: 20_000 });
    return { ok: r.code === 0, detail: r.code === 0 ? `${path} (${r.stdout.trim()})` : r.stderr.trim() };
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const budgetError = providerBudgetError(this, req.maxBudgetUsd);
    if (budgetError) return refusedRun(budgetError);
    if (Object.values(this.cfg.pricing).some((price) => !Number.isFinite(price) || price < 0)) {
      return refusedRun('Cursor token prices must be finite nonnegative numbers');
    }
    req.onLog('Cursor has no dollar cap; reported spending is estimated from token usage.');
    const prompt = `${agentPrompt(req)}\n\n## Required JSON schema\nYour final message must be only a JSON object matching this schema:\n${JSON.stringify(req.schema)}`;
    const args = ['--print', '--output-format', 'stream-json', '--trust', '--workspace', req.cwd];
    if (this.cfg.force) args.push('--force');
    if (this.cfg.model) args.push('--model', this.cfg.model);
    if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
    args.push(prompt);

    let result: Record<string, unknown> | null = null;
    let partial = '';
    const seenText: string[] = [];
    const parseLine = (line: string) => {
      if (!line.trim()) return;
      let ev: Record<string, any>;
      try { ev = JSON.parse(line); } catch { return; }
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return;
      noteSession(req, ev.session_id);
      this.describe(ev, req.onLog, seenText);
      if (ev.type === 'result') result = ev;
    };
    const onOutput = (chunk: string, stream: 'stdout' | 'stderr') => {
      if (stream === 'stderr') { for (const l of chunk.split('\n')) if (l.trim()) req.onLog(`stderr: ${l.trim()}`); return; }
      partial += chunk;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) parseLine(line);
    };

    const r = await exec([this.cfg.bin, ...args], { cwd: req.cwd, timeoutMs: req.timeoutMs, onOutput, signal: req.signal, env: { NO_COLOR: '1', FORCE_COLOR: '0' } });
    if (partial.trim()) parseLine(partial);

    const res = result as Record<string, any> | null;
    const usage = readUsage(res?.usage);
    const resultText = typeof res?.result === 'string' ? res.result : seenText.at(-1) ?? '';
    const output = resultText ? extractJson(resultText) : null;
    const p = this.cfg.pricing;
    const costUsd = usage && usage !== 'invalid'
      ? (usage.input * p.inputPerM + usage.cacheRead * p.cachedInputPerM + usage.cacheWrite * p.cacheWritePerM + usage.output * p.outputPerM) / 1_000_000
      : 0;
    const errText = [r.stderr, res?.is_error ? resultText : ''].join('\n');
    const exhausted = EXHAUSTED_RE.test(errText) || (r.code !== 0 && EXHAUSTED_RE.test(r.stdout.slice(-4000)));

    let error: string | null = null;
    if (r.timedOut) error = `cursor timed out after ${Math.round(req.timeoutMs / 60000)} min`;
    else if (r.code !== 0) error = `cursor exited ${r.code}: ${tail(r.stderr, 8, 600)}`;
    else if (!res) error = `cursor exited ${r.code} without a result: ${tail(r.stderr, 10, 800) || tail(r.stdout, 5, 800)}`;
    else if (res.is_error) error = `cursor reported an error (${res.subtype ?? 'unknown'}): ${tail(resultText, 6, 600)}`;
    else if (res.subtype && res.subtype !== 'success') error = `cursor stopped: ${res.subtype}`;
    else if (output == null) error = 'cursor finished without structured output';
    const costUnknown = usage == null || usage === 'invalid' || r.timedOut || r.code !== 0 || !!res?.is_error;
    if (costUnknown) error = `${error ?? 'cursor finished'}; final dollar usage is unknown (token usage was not reported)`;

    req.onLog(`result: ${error ? 'error' : 'ok'} · ${formatCost(costUsd, true, costUnknown, 3)} (estimated from tokens)`);
    return {
      output,
      costUsd,
      costEstimated: true,
      costUnknown,
      durationMs: r.durationMs,
      exhausted,
      error,
      sessionId: (res?.session_id as string) ?? null,
      rawTail: tail(seenText.join('\n'), 60, 6000),
    };
  }

  private describe(ev: Record<string, any>, log: (l: string) => void, seen: string[]) {
    if (ev.type === 'assistant') {
      const text = (ev.message?.content ?? []).map((block: any) => (typeof block?.text === 'string' ? block.text : '')).join('').trim();
      if (!text) return;
      seen.push(text);
      log(`💬 ${text.split('\n')[0]!.slice(0, 160)}`);
    } else if (ev.type === 'tool_call' && ev.subtype === 'started') {
      log(`🔧 ${toolBrief(ev.tool_call ?? {})}`);
    } else if (ev.type === 'system' && ev.subtype === 'init') {
      log(`session ${String(ev.session_id ?? '').slice(0, 8)} · model ${ev.model ?? '?'}`);
    }
  }
}

type TokenUsage = { input: number; cacheRead: number; cacheWrite: number; output: number };

/** Cursor's result usage lists uncached input, cache read, cache write, and output separately. */
function readUsage(usage: unknown): TokenUsage | 'invalid' | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;
  const input = u.inputTokens ?? u.input_tokens;
  const output = u.outputTokens ?? u.output_tokens;
  if (input === undefined && output === undefined) return null;
  const cacheRead = u.cacheReadTokens ?? u.cache_read_tokens ?? u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? u.cache_write_tokens ?? u.cache_creation_input_tokens ?? 0;
  const counts = [input, cacheRead, cacheWrite, output].map(nonnegative);
  if (counts.some((n) => n == null)) return 'invalid';
  return { input: counts[0]!, cacheRead: counts[1]!, cacheWrite: counts[2]!, output: counts[3]! };
}

function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function toolBrief(toolCall: Record<string, any>): string {
  const fn = toolCall.function;
  if (fn && typeof fn === 'object') return `${String(fn.name ?? 'tool')} ${String(fn.arguments ?? '').slice(0, 100)}`.trim();
  for (const [name, body] of Object.entries(toolCall)) {
    if (!body || typeof body !== 'object') continue;
    const args = (body as { args?: Record<string, unknown> }).args ?? {};
    const detail = args.command ?? args.cmd ?? args.path ?? args.file_path ?? args.pattern ?? args.glob ?? args.query ?? '';
    return `${name.replace(/ToolCall$/, '')} ${String(detail).split('\n')[0]!.slice(0, 140)}`.trim();
  }
  return 'tool';
}
