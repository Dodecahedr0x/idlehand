/** @jsxImportSource react */
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { expect, test } from 'bun:test';
import React from 'react';
import { render } from 'ink';
import type { Scheduler } from '../scheduler.ts';
import type { Candidate } from '../tasks/common.ts';
import { App } from './App.tsx';

class Stdin extends Readable {
  isTTY = true;
  override setRawMode() { return this; }
  override ref() { return this; }
  override unref() { return this; }
  override _read() {}
}

class Stdout extends Writable {
  isTTY = true;
  columns = 100;
  rows = 24;
  frame = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void) {
    this.frame += chunk.toString();
    cb();
  }
}

function cand(partial: Pick<Candidate, 'kind' | 'repo' | 'target' | 'label'>): Candidate {
  return partial as Candidate;
}

function plain(frame: string): string {
  return frame.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/g, '').replaceAll(/\u001B\][^\u0007]*\u0007/g, '');
}

test('the dashboard opens on the running overview and can show one task’s logs', async () => {
  const scheduler = new EventEmitter() as Scheduler & { stop: () => void };
  scheduler.stop = () => {};
  const stdin = new Stdin();
  const stdout = new Stdout();
  let ready!: () => void;
  const mounted = new Promise<void>((resolve) => { ready = resolve; });
  const instance = render(React.createElement(App, {
    scheduler,
    budget: { kind: 'usd', limitUsd: 5 },
    provider: 'claude',
    repos: ['acme/web'],
    onReady: () => ready(),
  }), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false });
  await mounted;
  expect(scheduler.listenerCount('event')).toBe(1);
  const review = cand({ kind: 'review-pr', repo: 'acme/web', target: 'pr:1', label: 'review PR #1 · login' });
  const fix = cand({ kind: 'fix-issue', repo: 'acme/api', target: 'issue:9', label: 'fix issue #9 · crash' });
  scheduler.emit('event', { type: 'plan', candidates: [review, fix] });
  scheduler.emit('event', { type: 'task-start', candidate: review, index: 0 });
  scheduler.emit('event', { type: 'task-start', candidate: fix, index: 1 });
  scheduler.emit('event', { type: 'log', candidate: review, line: 'reading the diff' });
  scheduler.emit('event', { type: 'log', candidate: fix, line: 'reproducing the crash' });
  await Bun.sleep(80);
  const overview = plain(stdout.frame);
  expect(overview).toContain('running');
  expect(overview).toContain('acme/web');
  expect(overview).toContain('acme/api');
  expect(overview).not.toContain('reading the diff');
  expect(overview).not.toContain('reproducing the crash');

  stdout.frame = '';
  stdin.push('\u001B[B');
  await Bun.sleep(50);
  stdin.push('\r');
  await Bun.sleep(80);
  const logs = plain(stdout.frame);
  expect(logs).toContain('reproducing the crash');
  expect(logs).not.toContain('reading the diff');
  expect(logs).not.toContain('queued');

  instance.unmount();
});
