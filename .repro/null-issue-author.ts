import { fixIssuePrompt } from '../apps/cli/src/tasks/prompts.ts';

const issue = {
  number: 12,
  title: 'Crash on empty input',
  body: 'It crashes',
  author: null,
  labels: [],
  assignees: [],
  url: 'https://github.com/o/r/issues/12',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  comments: { totalCount: 0 },
  state: 'OPEN',
};

const prompt = fixIssuePrompt('o/r', 'main', issue as never, 'idlehand/issue-12');
if (!prompt.includes('Opened by @ghost on 2026-01-01')) {
  throw new Error(`expected ghost author, got: ${prompt.slice(0, 200)}`);
}
console.log('GHOST_OK');
