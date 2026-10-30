export interface ServerConfig {
  port: number;
  baseUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  githubScopes: string;
  sessionSecret: string;
  dbPath: string;
  devLogin: boolean;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): ServerConfig {
  const baseUrl = (env.BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
  const isProd = env.NODE_ENV === 'production' || baseUrl.startsWith('https://');
  let sessionSecret = env.SESSION_SECRET ?? '';
  if (!sessionSecret) {
    if (isProd) throw new Error('SESSION_SECRET is required when BASE_URL is https or NODE_ENV=production');
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    sessionSecret = Buffer.from(buf).toString('hex');
    console.warn('[idlehand] SESSION_SECRET not set; generated a random one (sessions reset on restart)');
  }
  const githubClientId = env.GITHUB_CLIENT_ID ?? '';
  const githubClientSecret = env.GITHUB_CLIENT_SECRET ?? '';
  if (!githubClientId || !githubClientSecret) {
    console.warn('[idlehand] GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not set; "Sign in with GitHub" will fail. See .env.example');
  }
  return {
    port: Number(env.PORT ?? 8787),
    baseUrl,
    githubClientId,
    githubClientSecret,
    githubScopes: env.GITHUB_OAUTH_SCOPES ?? 'read:user',
    sessionSecret,
    dbPath: env.DB_PATH ?? './idlehand.sqlite',
    devLogin: env.IDLEHAND_DEV_LOGIN === '1',
  };
}
