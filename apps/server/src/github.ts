import type { RepoInput } from './db.ts';

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitHubClient {
  exchangeCode(code: string): Promise<string>;
  getUser(token: string): Promise<GitHubUser>;
  listUserRepos(token: string, page: number): Promise<RepoInput[]>;
  listPublicReposFor(login: string, page: number): Promise<RepoInput[]>;
  getRepo(owner: string, name: string, token?: string | null): Promise<RepoInput | null>;
  searchRepos(q: string, token?: string | null): Promise<RepoInput[]>;
  revokeAccessToken?(token: string): Promise<void>;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

interface ApiRepo {
  name: string;
  owner: { login: string };
  description: string | null;
  html_url: string;
  private: boolean;
  default_branch: string | null;
  language: string | null;
  stargazers_count: number;
}

export function apiRepoToInput(r: ApiRepo): RepoInput {
  return {
    owner: r.owner.login,
    name: r.name,
    description: r.description,
    htmlUrl: r.html_url,
    private: !!r.private,
    defaultBranch: r.default_branch ?? null,
    language: r.language ?? null,
    stars: r.stargazers_count ?? 0,
  };
}

export class RealGitHubClient implements GitHubClient {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private apiBase = 'https://api.github.com',
  ) {}

  private async api<T>(path: string, token?: string | null): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'idlehand',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${this.apiBase}${path}`, { headers });
    if (!res.ok) throw new GitHubError(`GitHub ${path} -> ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  async exchangeCode(code: string): Promise<string> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'idlehand' },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, code }),
    });
    const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      throw new GitHubError(data.error_description ?? data.error ?? 'OAuth exchange failed', res.status || 400);
    }
    return data.access_token;
  }

  async getUser(token: string): Promise<GitHubUser> {
    const u = await this.api<{ id: number; login: string; name: string | null; avatar_url: string | null }>('/user', token);
    return { id: u.id, login: u.login, name: u.name ?? null, avatarUrl: u.avatar_url ?? null };
  }

  async listUserRepos(token: string, page: number): Promise<RepoInput[]> {
    const rows = await this.api<ApiRepo[]>(`/user/repos?per_page=50&sort=updated&page=${page}`, token);
    return rows.map(apiRepoToInput);
  }

  async listPublicReposFor(login: string, page: number): Promise<RepoInput[]> {
    const rows = await this.api<ApiRepo[]>(`/users/${encodeURIComponent(login)}/repos?per_page=50&sort=updated&page=${page}`);
    return rows.map(apiRepoToInput);
  }

  async getRepo(owner: string, name: string, token?: string | null): Promise<RepoInput | null> {
    try {
      const r = await this.api<ApiRepo>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token);
      return apiRepoToInput(r);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  async searchRepos(q: string, token?: string | null): Promise<RepoInput[]> {
    const data = await this.api<{ items: ApiRepo[] }>(`/search/repositories?q=${encodeURIComponent(q)}&per_page=20`, token);
    return data.items.map(apiRepoToInput);
  }

  async revokeAccessToken(token: string): Promise<void> {
    const res = await fetch(`${this.apiBase}/applications/${encodeURIComponent(this.clientId)}/token`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'idlehand',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: JSON.stringify({ access_token: token }),
    });
    if (res.ok || res.status === 404) return;
    throw new GitHubError(`GitHub revoke -> ${res.status}`, res.status);
  }
}
