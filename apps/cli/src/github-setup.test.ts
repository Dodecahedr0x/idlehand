import { expect, test } from 'bun:test';
import { githubRepoFromRemote } from './github-setup.ts';

test('github remotes become owner/name', () => {
  expect(githubRepoFromRemote('https://github.com/Dodecahedr0x/idlehand.git')).toBe('Dodecahedr0x/idlehand');
  expect(githubRepoFromRemote('git@github.com:Dodecahedr0x/idlehand.git')).toBe('Dodecahedr0x/idlehand');
  expect(githubRepoFromRemote('https://example.com/idlehand/sample-alpha')).toBeNull();
});
