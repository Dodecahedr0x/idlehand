import { Scheduler } from '../apps/cli/src/scheduler.ts';
import { DEFAULT_CONFIG } from '../apps/cli/src/config.ts';
import { State } from '../apps/cli/src/state.ts';
import { parseBudget } from '../packages/shared/src/budget.ts';

let scans = 0;
const state = new State(':memory:');
const provider = {
  name: 'claude' as const,
  supportsUsdBudget: true,
  check: async () => ({ ok: true, detail: '' }),
  run: async () => { throw new Error('provider should not run'); },
};
const scheduler = new Scheduler({
  repos: ['o/r'],
  budget: parseBudget('remaining'),
  cfg: structuredClone(DEFAULT_CONFIG),
  provider,
  state,
  only: ['review-pr'],
  continuous: true,
  jobs: 1,
  idlePollMs: 20,
});
scheduler.scan = async () => {
  scans += 1;
  if (scans >= 40) scheduler.stop();
  return { login: 'me', scans: [{ repo: 'o/r', info: { archived: false, default_branch: 'main' } as never, prs: [], issues: [] }] };
};
const t0 = Date.now();
const result = await scheduler.run();
const elapsed = Date.now() - t0;
state.close();
console.log('SCANS', scans);
console.log('ELAPSED_MS', elapsed);
console.log('REASON', result.reason);
if (scans >= 40 && elapsed < 500) {
  console.error(`no backoff: ${scans} empty-queue scans in ${elapsed}ms`);
  process.exit(1);
}
console.log('scan rate looks bounded');
