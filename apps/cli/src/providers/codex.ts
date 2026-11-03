import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatCost } from '@idlehand/shared';
import type { Config } from '../config.ts';
import { exec, tail, which } from '../shell.ts';
import { EXHAUSTED_RE, agentPrompt, extractJson, noteSession, providerBudgetError, refusedRun, type AgentProvider, type AgentRunRequest, type AgentRunResult } from './types.ts';

/**
 * OpenAI Codex CLI in non-interactive mode: `codex exec --json`.
 * stdout is JSONL events; `turn.completed` carries token usage. The final
 * message is written to a file via `-o`. Codex does not report dollars, so
 * cost is *estimated* from tokens with the configured price table.
 */
export class CodexProvider implements AgentProvider {
  readonly name = 'codex' as const;
  readonly supportsUsdBudget = false;
  constructor(private cfg: Config['codex']) {}

  async check() {
    const path = await which(this.cfg.bin);
    if (!path) return { ok: false, detail: `${this.cfg.bin} not found on PATH (npm i -g @openai/codex)` };
    const r = await exec([this.cfg.bin, '--version'], { timeoutMs: 20_000 });
    return { ok: r.code === 0, detail: r.code === 0 ? `${path} (${r.stdout.trim()})` : r.stderr.trim() };
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const budgetError = providerBudgetError(this, req.maxBudgetUsd);
    if (budgetError) return refusedRun(budgetError);
    if (Object.values(this.cfg.pricing).some((price) => !Number.isFinite(price) || price < 0)) {
      return refusedRun('Codex token prices must be finite nonnegative numbers');
    }
    req.onLog('Codex has no dollar cap; reported spending is estimated from completed-turn token usage.');
    const tmp = mkdtempSync(join(tmpdir(), 'idlehand-codex-'));
    const schemaPath = join(tmp, 'schema.json');
    const lastPath = join(tmp, 'last.txt');
    writeFileSync(schemaPath, JSON.stringify(req.schema));
    const prompt = agentPrompt(req);
    const args = req.resumeSessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '--output-schema', schemaPath, '-o', lastPath]
      : ['exec', '--json', '-C', req.cwd, '-s', this.cfg.sandbox, '--skip-git-repo-check', '--output-schema', schemaPath, '-o', lastPath, '--color', 'never'];
    if (this.cfg.model) args.push('-m', this.cfg.model);
    if (req.resumeSessionId) args.push(req.resumeSessionId);
    args.push(prompt);

    let usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
    let sawUsage = false;
    let invalidUsage = false;
    let partial = '';
    let errorEvent: string | null = null;
    const texts: string[] = [];
    const parseLine = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return;
      noteSession(req, ev.thread_id ?? ev.session_id);
      const type = String(ev.type ?? '');
      if (type === 'turn.completed' && ev.usage) {
        const counts = [ev.usage.input_tokens, ev.usage.cached_input_tokens ?? 0, ev.usage.output_tokens];
        if (counts.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0) || counts[1] > counts[0]) {
          invalidUsage = true;
          return;
        }
        sawUsage = true;
        usage = {
          input_tokens: usage.input_tokens + (ev.usage.input_tokens ?? 0),
          cached_input_tokens: usage.cached_input_tokens + (ev.usage.cached_input_tokens ?? 0),
          output_tokens: usage.output_tokens + (ev.usage.output_tokens ?? 0),
        };
      } else if (type === 'item.completed' || type === 'item.started') {
        const item = ev.item ?? {};
        if (item.type === 'command_execution' && type === 'item.started') req.onLog(`🔧 ${String(item.command ?? '').split('\n')[0]!.slice(0, 140)}`);
        else if (item.type === 'agent_message' && type === 'item.completed') { texts.push(String(item.text ?? '')); req.onLog(`💬 ${String(item.text ?? '').split('\n')[0]!.slice(0, 160)}`); }
        else if (item.type === 'reasoning' && type === 'item.completed') req.onLog(`🧠 ${String(item.text ?? '').split('\n')[0]!.slice(0, 120)}`);
        else if (item.type === 'file_change' && type === 'item.completed') req.onLog(`✏️  ${(item.changes ?? []).map((c: any) => c.path).join(', ').slice(0, 140)}`);
      } else if (type === 'error' || type === 'turn.failed') {
        errorEvent = String(ev.message ?? ev.error?.message ?? JSON.stringify(ev)).slice(0, 500);
        req.onLog(`❌ ${errorEvent}`);
      }
    };
    const onOutput = (chunk: string, stream: 'stdout' | 'stderr') => {
      if (stream === 'stderr') { for (const l of chunk.split('\n')) if (l.trim()) req.onLog(`stderr: ${l.trim()}`); return; }
      partial += chunk;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) parseLine(line);
    };

    let r;
    try {
      r = await exec([this.cfg.bin, ...args], { cwd: req.cwd, timeoutMs: req.timeoutMs, onOutput, signal: req.signal, env: { NO_COLOR: '1' } });
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    if (partial.trim()) parseLine(partial);

    let last = '';
    try { last = readFileSync(lastPath, 'utf8'); } catch {}
    rmSync(tmp, { recursive: true, force: true });
    const output = last ? extractJson(last) : (texts.length ? extractJson(texts[texts.length - 1]!) : null);

    const p = this.cfg.pricing;
    const nonCached = Math.max(0, usage.input_tokens - usage.cached_input_tokens);
    const costUsd = (nonCached * p.inputPerM + usage.cached_input_tokens * p.cachedInputPerM + usage.output_tokens * p.outputPerM) / 1_000_000;
    const exhausted = EXHAUSTED_RE.test((errorEvent ?? '') + '\n' + r.stderr);

    let error: string | null = null;
    if (r.timedOut) error = `codex timed out after ${Math.round(req.timeoutMs / 60000)} min`;
    else if (errorEvent) error = `codex error: ${errorEvent}`;
    else if (r.code !== 0) error = `codex exited ${r.code}: ${tail(r.stderr, 8, 600)}`;
    else if (output == null) error = 'codex finished without structured output';
    const costUnknown = !sawUsage || invalidUsage || r.timedOut || !!errorEvent || r.code !== 0;
    if (costUnknown) error = `${error ?? 'codex finished'}; final dollar usage is unknown (only completed-turn tokens are accounted for)`;

    req.onLog(`result: ${error ? 'error' : 'ok'} · ${formatCost(costUsd, true, costUnknown, 3)} (estimated from ${usage.input_tokens + usage.output_tokens} tokens)`);
    return { output, costUsd, costEstimated: true, costUnknown, durationMs: r.durationMs, exhausted, error, sessionId: null, rawTail: tail(texts.join('\n'), 60, 6000) };
  }
}
