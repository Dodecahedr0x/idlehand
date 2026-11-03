import { expect, test } from 'bun:test';
import { exec, Stopped } from './shell.ts';

test('aborting a command stops it instead of waiting for the timeout', async () => {
  const signal = new AbortController();
  const pending = exec(['/bin/sleep', '30'], { signal: signal.signal, timeoutMs: 10_000 });
  signal.abort();
  await expect(pending).rejects.toBeInstanceOf(Stopped);
});
