/** @jsxImportSource react */
/** Ink dashboard for `idlehand run` in a TTY. */
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { formatBudget, formatCost, usdCap, type Budget, type BudgetUsage } from '@idlehand/shared';
import type { Scheduler, SchedulerEvent } from '../scheduler.ts';
import type { Candidate, TaskResult } from '../tasks/common.ts';

interface Row { candidate: Candidate; status: 'pending' | 'running' | 'done'; result?: TaskResult }

export interface AppProps {
  scheduler: Scheduler;
  budget: Budget;
  provider: string;
  repos: string[];
  subscriptionUsd?: number;
  onReady: () => void;
}

const KIND_LABEL: Record<string, string> = { 'review-pr': 'PR', 'fix-issue': 'ISSUE', 'review-codebase': 'CODE' };
const OUTCOME_COLOR: Record<string, string> = { reviewed: 'green', merged: 'green', 'pr-opened': 'green', 'issues-filed': 'green', 'nothing-found': 'gray', unverified: 'yellow', failed: 'red' };

export function App({ scheduler, budget, provider, repos, subscriptionUsd, onReady }: AppProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [info, setInfo] = useState<string>('scanning repositories…');
  const [usage, setUsage] = useState<BudgetUsage>({ spentUsd: 0, tasksCompleted: 0, elapsedMs: 0, providerExhausted: false });
  const [done, setDone] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [startedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  const [estimated, setEstimated] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const handler = (e: SchedulerEvent) => {
      switch (e.type) {
        case 'info': setInfo(e.message); break;
        case 'plan': setRows(e.candidates.map((c) => ({ candidate: c, status: 'pending' }))); setInfo(e.candidates.length ? `${e.candidates.length} task(s) queued` : 'nothing to do'); break;
        case 'task-start':
          setRows((r) => r.map((row) => (row.candidate.target === e.candidate.target && row.candidate.repo === e.candidate.repo ? { ...row, status: 'running' } : row)));
          setLogs([]);
          break;
        case 'log': setLogs((l) => [...l, e.line].slice(-14)); break;
        case 'task-done':
          setRows((r) => r.map((row) => (row.candidate.target === e.candidate.target && row.candidate.repo === e.candidate.repo ? { ...row, status: 'done', result: e.result } : row)));
          setUsage({ ...e.usage });
          if (e.result.costEstimated) setEstimated(true);
          break;
        case 'budget': setUsage({ ...e.usage }); break;
        case 'done': setUsage({ ...e.usage }); setDone(e.reason); break;
      }
    };
    scheduler.on('event', handler);
    onReady();
    return () => { scheduler.off('event', handler); };
  }, [scheduler, onReady]);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      if (done) return;
      setStopping(true);
      scheduler.stop();
    }
  });

  const cap = usdCap(budget, subscriptionUsd);
  const spentStr = formatCost(usage.spentUsd, estimated, usage.costUnknown);
  const elapsedMs = done ? usage.elapsedMs : Math.max(usage.elapsedMs, now - startedAt);
  const barWidth = 28;
  let bar = '';
  if (usage.costUnknown) {
    bar = 'spending unknown; accounting incomplete';
  } else if (cap != null) {
    const frac = Math.min(1, usage.spentUsd / cap);
    const filled = Math.round(frac * barWidth);
    bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  } else if (budget.kind === 'tasks') {
    const frac = Math.min(1, usage.tasksCompleted / budget.limit);
    const filled = Math.round(frac * barWidth);
    bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  } else if (budget.kind === 'minutes') {
    const frac = Math.min(1, elapsedMs / (budget.limit * 60000));
    const filled = Math.round(frac * barWidth);
    bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  } else {
    bar = '∞ until the provider says stop';
  }
  const elapsed = `${Math.floor(elapsedMs / 60000)}m ${Math.floor(elapsedMs / 1000) % 60}s`;
  const running = rows.find((r) => r.status === 'running');
  const doneRows = rows.filter((r) => r.status === 'done');
  const pendingRows = rows.filter((r) => r.status === 'pending');
  const visible = [...doneRows.slice(-4), ...(running ? [running] : []), ...pendingRows.slice(0, 6)];
  const hiddenPending = Math.max(0, pendingRows.length - 6);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color="magenta">idlehand</Text>
          <Text dimColor> · {provider} · {repos.length} repo{repos.length === 1 ? '' : 's'}</Text>
        </Text>
        <Text dimColor>{done ? 'finished' : stopping ? 'stopping after this task… ' : 'q / Ctrl+C to stop after this task'}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text dimColor>budget </Text>
          <Text>{formatBudget(budget, subscriptionUsd)}</Text>
          <Text dimColor>  spent </Text>
          <Text color="cyan">{spentStr}</Text>
          <Text dimColor>  tasks </Text>
          <Text>{usage.tasksCompleted}</Text>
          <Text dimColor>  time </Text>
          <Text>{elapsed}</Text>
        </Text>
        <Text color={cap != null && usage.spentUsd / cap > 0.9 ? 'yellow' : 'magenta'}>{bar}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>queue</Text>
        {rows.length === 0 && !done && (
          <Text dimColor>
            <Spinner type="dots" /> {info}
          </Text>
        )}
        {visible.map((r) => (
          <Box key={r.candidate.repo + r.candidate.target}>
            <Box width={3}>
              {r.status === 'running' ? (
                <Text color="cyan"><Spinner type="dots" /></Text>
              ) : r.status === 'done' ? (
                <Text color={OUTCOME_COLOR[r.result!.outcome] ?? 'gray'}>{r.result!.outcome === 'failed' ? '!' : r.result!.outcome === 'unverified' ? '✗' : r.result!.outcome === 'nothing-found' ? '·' : '✓'}</Text>
              ) : (
                <Text dimColor>○</Text>
              )}
            </Box>
            <Box width={6}><Text dimColor>{KIND_LABEL[r.candidate.kind]}</Text></Box>
            <Box width={28}><Text dimColor wrap="truncate">{r.candidate.repo}</Text></Box>
            <Box flexGrow={1}>
              <Text wrap="truncate" dimColor={r.status === 'pending'}>{r.candidate.label.replace(/^(review PR|fix issue|review codebase)\s*/, '')}</Text>
            </Box>
            {r.status === 'done' && r.result && (
              <Box marginLeft={1}>
                <Text color={OUTCOME_COLOR[r.result.outcome] ?? 'gray'}>{r.result.outcome}</Text>
                <Text dimColor> {formatCost(r.result.costUsd, r.result.costEstimated, r.result.costUnknown)}</Text>
              </Box>
            )}
          </Box>
        ))}
        {hiddenPending > 0 && <Text dimColor>  … {hiddenPending} more queued</Text>}
      </Box>

      {running && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text dimColor>{running.candidate.repo} — {running.candidate.label}</Text>
          {logs.length === 0 ? <Text dimColor>…</Text> : logs.map((l, i) => <Text key={i} wrap="truncate">{l}</Text>)}
        </Box>
      )}

      {done && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={doneRows.some((r) => r.result?.outcome === 'failed') ? 'red' : 'green'}>done</Text>
          <Text>{done}</Text>
          {doneRows.filter((r) => r.result?.url).map((r) => (
            <Text key={r.candidate.target + r.candidate.repo} dimColor>  {r.result!.outcome} {r.result!.url}</Text>
          ))}
        </Box>
      )}
      <Text> </Text>
    </Box>
  );
}
