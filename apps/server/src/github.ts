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
  name?: string;
  owner?: { login?: string };
  description: string | null;
  html_url?: string;
  private: boolean;
  default_branch: string | null;
  language: string | null;
  stargazers_count: number;
}

const LOGIN = /^[\w.-]+$/;

function pathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** GitHub sometimes puts a display name in `owner.login`. The public URL is the name we can import. */
export function apiRepoToInput(r: ApiRepo): RepoInput | null {
  let owner = r.owner?.login ?? '';
  let name = r.name ?? '';
  const fromUrl = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i.exec(r.html_url ?? '');
  if (fromUrl && (!LOGIN.test(owner) || !LOGIN.test(name))) {
    owner = pathPart(fromUrl[1]!);
    name = pathPart(fromUrl[2]!);
  }
  if (!LOGIN.test(owner) || !LOGIN.test(name) || !r.html_url) return null;
  return {
    owner,
    name,
    description: r.description,
    htmlUrl: r.html_url,
    private: !!r.private,
    defaultBranch: r.default_branch ?? null,
    language: r.language ?? null,
    stars: r.stargazers_count ?? 0,
  };
}

function inputsFrom(rows: ApiRepo[]): RepoInput[] {
  return rows.flatMap((row) => {
    const input = apiRepoToInput(row);
    return input ? [input] : [];
  });
}

/** A read:user token cannot search private repos. Asking for them makes GitHub reject the query. */
export function publicSearchQuery(q: string): string {
  const trimmed = q.trim();
  if (/\bis:(public|private|internal)\b/i.test(trimmed)) return trimmed;
  return `${trimmed} is:public`;
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
    // visibility=public and affiliation=owner: default visibility=all returns 403 for a
    // read:user token when the account has private repos or an organization blocks the app.
    const rows = await this.api<ApiRepo[]>(
      `/user/repos?per_page=50&sort=updated&page=${page}&visibility=public&affiliation=owner`,
      token,
    );
    return inputsFrom(rows);
  }

  async listPublicReposFor(login: string, page: number): Promise<RepoInput[]> {
    const rows = await this.api<ApiRepo[]>(`/users/${encodeURIComponent(login)}/repos?per_page=50&sort=updated&page=${page}`);
    return inputsFrom(rows);
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
    const data = await this.api<{ items: ApiRepo[] }>(
      `/search/repositories?q=${encodeURIComponent(publicSearchQuery(q))}&per_page=20`,
      token,
    );
    return inputsFrom(data.items ?? []);
  }
}
