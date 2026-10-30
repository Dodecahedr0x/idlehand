/** Client for the Idlehand web service (apps/server). */
import type { DeviceCodePoll, DeviceCodeStart, Me, RunReport, SelectedRepo, StoredRunReport } from '@idlehand/shared';

export class ServerError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class ServerClient {
  constructor(readonly baseUrl: string, private token: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async req<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { 'X-Requested-With': 'fetch', Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw new ServerError(`cannot reach ${this.baseUrl}: ${(e as Error).message}`, 0);
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw new ServerError(json?.error ?? `${res.status} ${res.statusText}`, res.status);
    return json as T;
  }

  health() { return this.req<{ ok: boolean }>('GET', '/healthz', undefined, false); }
  startDeviceCode() { return this.req<DeviceCodeStart>('POST', '/api/cli/codes', {}, false); }
  pollDeviceCode(deviceCode: string) { return this.req<DeviceCodePoll>('GET', `/api/cli/codes/${deviceCode}`, undefined, false); }
  me() { return this.req<Me>('GET', '/api/cli/me'); }
  repos() { return this.req<SelectedRepo[]>('GET', '/api/cli/repos'); }
  report(r: RunReport) { return this.req<StoredRunReport>('POST', '/api/cli/runs', r); }
}
