import type { Config } from '../config.ts';
import { formatCost } from '@idlehand/shared';
import { exec, tail, which } from '../shell.ts';
import { EXHAUSTED_RE, agentPrompt, extractJson, noteSession, providerBudgetError, refusedRun, type AgentProvider, type AgentRunRequest, type AgentRunResult } from './types.ts';

/**
 * Claude Code in headless mode: `claude -p --output-format stream-json`.
 * Each stdout line is a JSON event; the final `type: "result"` event carries
 * `total_cost_usd`, `structured_output` (when --json-schema is used) and
 * `is_error`.
 */
export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const;
  readonly supportsUsdBudget = true;
  constructor(private cfg: Config['claude']) {}

  async check() {
    const path = await which(this.cfg.bin);
    if (!path) return { ok: false, detail: `${this.cfg.bin} not found on PATH (install Claude Code: https://docs.claude.com/en/docs/claude-code)` };
    const r = await exec([this.cfg.bin, '--version'], { timeoutMs: 20_000 });
    return { ok: r.code === 0, detail: r.code === 0 ? `${path} (${r.stdout.trim()})` : r.stderr.trim() };
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const budgetError = providerBudgetError(this, req.maxBudgetUsd);
    if (budgetError) return refusedRun(budgetError);
    const args = [
      '-p', agentPrompt(req),
      '--output-format', 'stream-json', '--verbose',
      '--json-schema', JSON.stringify(req.schema),
      '--permission-mode', this.cfg.permissionMode,
      '--max-turns', String(this.cfg.maxTurns),
    ];
    if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
    if (this.cfg.allowedTools.length) args.push('--allowedTools', ...this.cfg.allowedTools);
    if (this.cfg.model) args.push('--model', this.cfg.model);
    if (req.maxBudgetUsd != null) args.push('--max-budget-usd', String(req.maxBudgetUsd));

    let result: Record<string, unknown> | null = null;
    let partial = '';
    const seenText: string[] = [];
    const onOutput = (chunk: string, stream: 'stdout' | 'stderr') => {
      if (stream === 'stderr') { for (const l of chunk.split('\n')) if (l.trim()) req.onLog(`stderr: ${l.trim()}`); return; }
      partial += chunk;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
        noteSession(req, ev.session_id);
        this.describe(ev, req.onLog, seenText);
        if (ev.type === 'result') result = ev;
      }
    };

    const r = await exec([this.cfg.bin, ...args], {
      cwd: req.cwd,
      timeoutMs: req.timeoutMs,
      onOutput,
      signal: req.signal,
      env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', FORCE_COLOR: '0' },
    });
    if (!result && partial.trim()) { try { const ev = JSON.parse(partial); if (ev && typeof ev === 'object' && ev.type === 'result') result = ev; } catch {} }

    const res = result as Record<string, any> | null;
    const costKnown = typeof res?.total_cost_usd === 'number' && Number.isFinite(res.total_cost_usd) && res.total_cost_usd >= 0;
    const costUsd = costKnown ? res!.total_cost_usd as number : 0;
    const resultText = typeof res?.result === 'string' ? res.result : '';
    const errText = [r.stderr, res?.is_error ? resultText : ''].join('\n');
    const exhausted = EXHAUSTED_RE.test(errText) || (r.code !== 0 && EXHAUSTED_RE.test(r.stdout.slice(-4000)));
    let output: unknown | null = res?.structured_output ?? null;
    if (output == null && resultText) output = extractJson(resultText);

    let error: string | null = null;
    if (r.timedOut) error = `claude timed out after ${Math.round(req.timeoutMs / 60000)} min`;
    else if (r.code !== 0) error = `claude exited ${r.code}: ${tail(r.stderr, 8, 600)}`;
    else if (!res) error = `claude exited ${r.code} without a result: ${tail(r.stderr, 10, 800) || tail(r.stdout, 5, 800)}`;
    else if (res.is_error) error = `claude reported an error (${res.subtype ?? 'unknown'}): ${tail(resultText, 6, 600)}`;
    else if (res.subtype && res.subtype !== 'success') error = `claude stopped: ${res.subtype}`;
    else if (output == null) error = 'claude finished without structured output';
    if (!costKnown) {
      error = `${error ?? 'claude finished'}; dollar usage is unknown because final accounting was not reported`;
      req.onLog(error);
    }
    if (req.maxBudgetUsd != null && costKnown && costUsd > req.maxBudgetUsd) {
      error ??= `claude reached the $${req.maxBudgetUsd} budget threshold (reported $${costUsd}); in-flight usage can exceed the threshold`;
    }

    return {
      output,
      costUsd,
      costEstimated: true,
      costUnknown: !costKnown,
      durationMs: r.durationMs,
      exhausted,
      error,
      sessionId: (res?.session_id as string) ?? null,
      rawTail: tail(seenText.join('\n'), 60, 6000),
    };
  }

  private describe(ev: Record<string, any>, log: (l: string) => void, seen: string[]) {
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content as any[]) {
        if (block.type === 'text' && block.text?.trim()) {
          const t = String(block.text).trim().split('\n')[0]!.slice(0, 160);
          seen.push(block.text);
          log(`💬 ${t}`);
        } else if (block.type === 'tool_use') {
          const input = block.input ?? {};
          const brief =
            block.name === 'Bash' ? String(input.command ?? '').split('\n')[0]!.slice(0, 140)
            : block.name === 'Read' || block.name === 'Edit' || block.name === 'Write' ? String(input.file_path ?? '')
            : block.name === 'Grep' || block.name === 'Glob' ? String(input.pattern ?? '')
            : JSON.stringify(input).slice(0, 100);
          log(`🔧 ${block.name} ${brief}`);
        }
      }
    } else if (ev.type === 'system' && ev.subtype === 'init') {
      log(`session ${String(ev.session_id ?? '').slice(0, 8)} · model ${ev.model ?? '?'}`);
    } else if (ev.type === 'result') {
      const known = typeof ev.total_cost_usd === 'number' && Number.isFinite(ev.total_cost_usd) && ev.total_cost_usd >= 0;
      log(`result: ${ev.subtype} · ${formatCost(known ? ev.total_cost_usd : 0, true, !known, 3)} · ${ev.num_turns ?? '?'} turns`);
    }
  }
}
