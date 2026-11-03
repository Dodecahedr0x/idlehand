/** Task list for the run dashboard. Overview by default; one task's logs on demand. */
import type { SchedulerEvent } from '../scheduler.ts';

export interface DashTask {
  kind: string;
  repo: string;
  target: string;
  label: string;
  /** Set once the task starts, so two runs of the same target stay distinct. */
  slot?: number;
  status: 'pending' | 'running' | 'done';
  logs: string[];
  outcome?: string;
  costUsd?: number;
  costEstimated?: boolean;
  costUnknown?: boolean;
  url?: string | null;
}

export interface DashState {
  tasks: DashTask[];
  /** Index into `rows()`. */
  selected: number;
  /** Set while a single task's logs fill the screen. */
  focus: string | null;
  info: string;
}

interface KeyPress {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
}

const LOG_CAP = 200;
const LINE_CAP = 500;
// ponytail: fixed overview window, not a scrollback. `--plain` is the full stream.
const PENDING_CAP = 8;
const DONE_CAP = 5;
const DONE_KEEP = 30;

export const emptyDash = (): DashState => ({ tasks: [], selected: 0, focus: null, info: 'scanning repositories…' });

export function taskId(t: { repo: string; target: string; slot?: number }): string {
  const target = `${t.repo}\0${t.target}`;
  return t.slot == null ? target : `${t.slot}\0${target}`;
}

function locate(tasks: DashTask[], candidate: { repo: string; target: string }, index?: number): number {
  if (index != null) {
    const exact = tasks.findIndex((t) => t.slot === index);
    if (exact >= 0) return exact;
  }
  const same = tasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.repo === candidate.repo && t.target === candidate.target);
  if (index == null) return same.find(({ t }) => t.status === 'running')?.i ?? same[0]?.i ?? -1;
  return same.find(({ t }) => t.slot == null)?.i ?? -1;
}

function ordered(tasks: DashTask[]): DashTask[] {
  return [
    ...tasks.filter((t) => t.status === 'running'),
    ...tasks.filter((t) => t.status === 'pending'),
    ...tasks.filter((t) => t.status === 'done'),
  ];
}

/** Running tasks, then a window of the queue and the latest finished tasks. */
export function rows(s: DashState): DashTask[] {
  const all = ordered(s.tasks);
  return [
    ...all.filter((t) => t.status === 'running'),
    ...all.filter((t) => t.status === 'pending').slice(0, PENDING_CAP),
    ...all.filter((t) => t.status === 'done').slice(-DONE_CAP),
  ];
}

export function hiddenCounts(s: DashState): { pending: number; done: number } {
  const pending = s.tasks.filter((t) => t.status === 'pending').length;
  const done = s.tasks.filter((t) => t.status === 'done').length;
  return { pending: Math.max(0, pending - PENDING_CAP), done: Math.max(0, done - DONE_CAP) };
}

export function focusedLogs(s: DashState): string[] {
  return s.tasks.find((t) => taskId(t) === s.focus)?.logs ?? [];
}

function trimDone(tasks: DashTask[], focus: string | null): DashTask[] {
  const done = tasks.filter((t) => t.status === 'done');
  if (done.length <= DONE_KEEP) return tasks;
  const drop = new Set(done.slice(0, done.length - DONE_KEEP).map(taskId));
  if (focus) drop.delete(focus);
  return tasks.filter((t) => !drop.has(taskId(t)));
}

function commit(prev: DashState, tasks: DashTask[], patch: Partial<DashState> = {}): DashState {
  const focus = prev.focus && tasks.some((t) => taskId(t) === prev.focus) ? prev.focus : null;
  const trimmed = trimDone(tasks, focus);
  const selectedId = rows(prev)[prev.selected] ? taskId(rows(prev)[prev.selected]!) : null;
  const draft: DashState = { ...prev, ...patch, tasks: trimmed, focus };
  const list = rows(draft);
  const keep = selectedId ? list.findIndex((t) => taskId(t) === selectedId) : -1;
  const selected = keep >= 0 ? keep : Math.min(prev.selected, Math.max(0, list.length - 1));
  return { ...draft, selected };
}

function fromCandidate(c: { kind: string; repo: string; target: string; label: string }, status: DashTask['status'], logs: string[] = []): DashTask {
  return { kind: c.kind, repo: c.repo, target: c.target, label: c.label, status, logs };
}

function remember(logs: string[], line: string): string[] {
  const extra = line.split('\n').map((l) => l.slice(0, LINE_CAP)).filter((l) => l.length > 0);
  return extra.length ? [...logs, ...extra].slice(-LOG_CAP) : logs;
}

export function applyEvent(s: DashState, e: SchedulerEvent): DashState {
  switch (e.type) {
    case 'info':
      return { ...s, info: e.message };
    case 'plan': {
      const prev = new Map(s.tasks.map((t) => [taskId(t), t]));
      const seen = new Set<string>();
      const next: DashTask[] = [];
      for (const c of e.candidates) {
        const id = taskId(c);
        seen.add(id);
        const had = prev.get(id);
        if (had && had.status !== 'pending') next.push({ ...had, kind: c.kind, label: c.label });
        else next.push(had ? { ...had, kind: c.kind, label: c.label, status: 'pending' } : fromCandidate(c, 'pending'));
      }
      for (const t of s.tasks) if (!seen.has(taskId(t)) && t.status !== 'pending') next.push(t);
      const queued = e.candidates.length;
      return commit(s, next, { info: queued ? `${queued} task(s) queued` : 'nothing to do' });
    }
    case 'task-start': {
      const pendingAt = s.tasks.findIndex((t) => t.status === 'pending' && t.slot == null && t.repo === e.candidate.repo && t.target === e.candidate.target);
      const existing = s.tasks.findIndex((t) => t.slot === e.index);
      const base = pendingAt >= 0 ? s.tasks[pendingAt]! : existing >= 0 ? s.tasks[existing]! : fromCandidate(e.candidate, 'running');
      const row: DashTask = { ...base, kind: e.candidate.kind, label: e.candidate.label, status: 'running', slot: e.index };
      const tasks = existing >= 0
        ? s.tasks.map((t, i) => (i === existing ? { ...row, logs: t.logs } : t))
        : pendingAt >= 0
          ? s.tasks.map((t, i) => (i === pendingAt ? row : t))
          : [...s.tasks, row];
      return commit(s, tasks);
    }
    case 'log': {
      const at = locate(s.tasks, e.candidate, e.index);
      if (at < 0) return commit(s, [...s.tasks, { ...fromCandidate(e.candidate, 'running'), slot: e.index, logs: remember([], e.line) }]);
      return commit(s, s.tasks.map((t, i) => (i === at ? { ...t, logs: remember(t.logs, e.line) } : t)));
    }
    case 'task-done': {
      const at = locate(s.tasks, e.candidate, e.index);
      const had = at >= 0 ? s.tasks[at]! : { ...fromCandidate(e.candidate, 'done'), slot: e.index };
      const updated: DashTask = {
        ...had,
        kind: e.candidate.kind,
        label: e.candidate.label,
        status: 'done',
        slot: e.index ?? had.slot,
        outcome: e.result.outcome,
        costUsd: e.result.costUsd,
        costEstimated: e.result.costEstimated,
        costUnknown: e.result.costUnknown,
        url: e.result.url,
      };
      return commit(s, at >= 0 ? s.tasks.map((t, i) => (i === at ? updated : t)) : [...s.tasks, updated]);
    }
    default:
      return s;
  }
}

export function applyKey(s: DashState, input: string, key: KeyPress = {}): DashState {
  if (s.focus) return key.escape || key.backspace || key.leftArrow ? { ...s, focus: null } : s;
  const list = rows(s);
  if (!list.length) return s;
  if (key.upArrow || input === 'k') return { ...s, selected: Math.max(0, s.selected - 1) };
  if (key.downArrow || input === 'j') return { ...s, selected: Math.min(list.length - 1, s.selected + 1) };
  if (key.return || key.rightArrow || input === 'l') {
    const t = list[s.selected];
    return t ? { ...s, focus: taskId(t) } : s;
  }
  return s;
}
