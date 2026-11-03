/** @jsxImportSource react */
/** Ink dashboard for `idlehand run` in a TTY. */
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { formatBudget, formatCost, usdCap, type Budget, type BudgetUsage } from '@idlehand/shared';
import type { Scheduler, SchedulerEvent } from '../scheduler.ts';
import { applyEvent, applyKey, emptyDash, hiddenCounts, rows, taskId, type DashTask } from './dashboard.ts';

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
  const [dash, setDash] = useState(emptyDash);
  const [usage, setUsage] = useState<BudgetUsage>({ spentUsd: 0, tasksCompleted: 0, elapsedMs: 0, providerExhausted: false });
  const [done, setDone] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [startedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  const [estimated, setEstimated] = useState(false);
  const { stdout } = useStdout();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const handler = (e: SchedulerEvent) => {
      setDash((d) => applyEvent(d, e));
      if (e.type === 'task-done') {
        setUsage({ ...e.usage });
        if (e.result.costEstimated) setEstimated(true);
      } else if (e.type === 'budget' || e.type === 'done') setUsage({ ...e.usage });
      if (e.type === 'done') setDone(e.reason);
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
      return;
    }
    setDash((d) => applyKey(d, input, key));
  });

  const cap = usdCap(budget, subscriptionUsd);
  const spentStr = formatCost(usage.spentUsd, estimated, usage.costUnknown);
  const elapsedMs = done ? usage.elapsedMs : Math.max(usage.elapsedMs, now - startedAt);
  const bar = budgetBar(budget, usage, cap, elapsedMs);
  const elapsed = `${Math.floor(elapsedMs / 60000)}m ${Math.floor(elapsedMs / 1000) % 60}s`;
  const list = rows(dash);
  const hidden = hiddenCounts(dash);
  const selected = list[dash.selected];
  const focused = dash.focus ? dash.tasks.find((t) => taskId(t) === dash.focus) : undefined;
  const hint = done ? 'finished' : stopping ? 'stopping; the next run resumes these tasks' : focused ? 'esc back · q stop' : '↑↓ select · enter logs · q stop';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color="magenta">idlehand</Text>
          <Text dimColor> · {provider} · {repos.length} repo{repos.length === 1 ? '' : 's'}</Text>
        </Text>
        <Text dimColor>{hint}</Text>
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

      {focused ? (
        <LogView task={focused} tail={Math.max(4, (stdout?.rows ?? 24) - 8)} />
      ) : (
        <Overview list={list} selectedId={selected ? taskId(selected) : null} hidden={hidden} info={dash.info} scanning={list.length === 0 && !done} />
      )}

      {done && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={dash.tasks.some((t) => t.outcome === 'failed') ? 'red' : 'green'}>done</Text>
          <Text>{done}</Text>
        </Box>
      )}
      <Text> </Text>
    </Box>
  );
}

function Overview({ list, selectedId, hidden, info, scanning }: { list: DashTask[]; selectedId: string | null; hidden: { pending: number; done: number }; info: string; scanning: boolean }) {
  const running = list.filter((t) => t.status === 'running');
  const pending = list.filter((t) => t.status === 'pending');
  const doneRows = list.filter((t) => t.status === 'done');
  const byRepo = new Map<string, DashTask[]>();
  for (const t of running) {
    const group = byRepo.get(t.repo);
    if (group) group.push(t);
    else byRepo.set(t.repo, [t]);
  }
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>running</Text>
      {scanning && <Text dimColor><Spinner type="dots" /> {info}</Text>}
      {!scanning && running.length === 0 && <Text dimColor>nothing running</Text>}
      {[...byRepo].map(([repo, tasks]) => (
        <Box key={repo} flexDirection="column">
          <Text color="cyan">{repo}</Text>
          {tasks.map((t) => <TaskLine key={taskId(t)} task={t} selected={taskId(t) === selectedId} />)}
        </Box>
      ))}
      {pending.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>queued</Text>
          {pending.map((t) => <TaskLine key={taskId(t)} task={t} selected={taskId(t) === selectedId} />)}
          {hidden.pending > 0 && <Text dimColor>  … {hidden.pending} more queued</Text>}
        </Box>
      )}
      {doneRows.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>finished</Text>
          {hidden.done > 0 && <Text dimColor>  … {hidden.done} earlier</Text>}
          {doneRows.map((t) => <TaskLine key={taskId(t)} task={t} selected={taskId(t) === selectedId} />)}
        </Box>
      )}
    </Box>
  );
}

function TaskLine({ task, selected }: { task: DashTask; selected: boolean }) {
  const mark = task.status === 'running' ? null : task.status === 'done' ? doneMark(task.outcome) : '○';
  return (
    <Box>
      <Box width={2}>{selected ? <Text color="magenta">›</Text> : <Text> </Text>}</Box>
      <Box width={2}>
        {task.status === 'running' ? <Text color="cyan"><Spinner type="dots" /></Text> : <Text color={task.outcome ? OUTCOME_COLOR[task.outcome] ?? 'gray' : 'gray'}>{mark}</Text>}
      </Box>
      <Box width={6}><Text dimColor>{KIND_LABEL[task.kind] ?? task.kind}</Text></Box>
      {task.status === 'running' ? null : <Box width={28}><Text dimColor wrap="truncate">{task.repo}</Text></Box>}
      <Box flexGrow={1}><Text wrap="truncate" dimColor={task.status === 'pending'}>{shortLabel(task.label)}</Text></Box>
      {task.status === 'done' && task.outcome && (
        <Box marginLeft={1}>
          <Text color={OUTCOME_COLOR[task.outcome] ?? 'gray'}>{task.outcome}</Text>
          <Text dimColor> {formatCost(task.costUsd ?? 0, !!task.costEstimated, !!task.costUnknown)}</Text>
        </Box>
      )}
    </Box>
  );
}

function LogView({ task, tail }: { task: DashTask; tail: number }) {
  const lines = task.logs.slice(-tail);
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>
        <Text color="cyan">{task.repo}</Text>
        <Text> {shortLabel(task.label)}</Text>
        {task.status === 'done' && task.outcome ? <Text color={OUTCOME_COLOR[task.outcome] ?? 'gray'}> {task.outcome}</Text> : <Text dimColor>{task.status === 'pending' ? ' queued' : ' running'}</Text>}
      </Text>
      {task.url ? <Text dimColor>{task.url}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        {lines.length === 0 ? <Text dimColor>no output yet</Text> : lines.map((line, i) => <Text key={i} wrap="truncate">{line}</Text>)}
      </Box>
    </Box>
  );
}

function shortLabel(label: string): string {
  return label.replace(/^(review PR|fix issue|review codebase)\s*/, '');
}

function doneMark(outcome?: string): string {
  if (outcome === 'failed') return '!';
  if (outcome === 'unverified') return '✗';
  if (outcome === 'nothing-found') return '·';
  return '✓';
}

function budgetBar(budget: Budget, usage: BudgetUsage, cap: number | null, elapsedMs: number): string {
  const barWidth = 28;
  if (usage.costUnknown) return 'spending unknown; accounting incomplete';
  const fill = (frac: number) => '█'.repeat(Math.round(Math.min(1, frac) * barWidth)) + '░'.repeat(barWidth - Math.round(Math.min(1, frac) * barWidth));
  if (cap != null) return fill(usage.spentUsd / cap);
  if (budget.kind === 'tasks') return fill(usage.tasksCompleted / budget.limit);
  if (budget.kind === 'minutes') return fill(elapsedMs / (budget.limit * 60000));
  return '∞ until the provider says stop';
}
