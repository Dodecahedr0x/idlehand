import { expect, test } from 'bun:test';
import { RealGitHubClient, apiRepoToInput, type GitHubClient } from './github.ts';

const repo = {
  name: 'idlehand',
  owner: { login: 'JohnPaul Zigterman' },
  description: null,
  html_url: 'https://github.com/JohnPaulZigterman/idlehand',
  private: false,
  default_branch: 'main',
  language: 'TypeScript',
  stargazers_count: 0,
};

test('a repository login with a space is imported from its GitHub URL', () => {
  expect(apiRepoToInput(repo)).toMatchObject({ owner: 'JohnPaulZigterman', name: 'idlehand', htmlUrl: repo.html_url });
});

test('listing and search ask GitHub only for public repositories', async () => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    const body = String(url).includes('/search/') ? { items: [repo] } : [repo];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const github: GitHubClient = new RealGitHubClient('id', 'secret');
    const listed = await github.listUserRepos('token', 2);
    const found = await github.searchRepos('user:Dodecahedr0x', 'token');
    expect(listed[0]).toMatchObject({ owner: 'JohnPaulZigterman', name: 'idlehand' });
    expect(found[0]).toMatchObject({ owner: 'JohnPaulZigterman', name: 'idlehand' });
    expect(urls[0]).toContain('/user/repos?');
    expect(urls[0]).toContain('visibility=public');
    expect(urls[0]).toContain('affiliation=owner');
    expect(urls[0]).toContain('page=2');
    expect(urls[1]).toContain('/search/repositories?q=');
    expect(urls[1]).toContain(encodeURIComponent('user:Dodecahedr0x is:public'));
  } finally {
    globalThis.fetch = original;
  }
});
