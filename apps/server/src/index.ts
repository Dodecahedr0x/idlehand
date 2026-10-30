import { configFromEnv } from './config.ts';
import { createApp } from './app.ts';
import { Store } from './db.ts';
import { RealGitHubClient } from './github.ts';

const config = configFromEnv();
const store = new Store(config.dbPath);
const github = new RealGitHubClient(config.githubClientId, config.githubClientSecret);
const app = createApp({ config, store, github });

const server = Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`[idlehand] listening on http://localhost:${server.port}  (BASE_URL=${config.baseUrl}${config.devLogin ? ', dev login ON' : ''})`);
