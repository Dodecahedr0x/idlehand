import type { Provider } from '@idlehand/shared';
import type { Config } from '../config.ts';
import { ClaudeProvider } from './claude.ts';
import { CodexProvider } from './codex.ts';
import { CursorProvider } from './cursor.ts';
import type { AgentProvider } from './types.ts';

export function makeProvider(name: Provider, cfg: Config): AgentProvider {
  switch (name) {
    case 'codex': return new CodexProvider(cfg.codex);
    case 'cursor': return new CursorProvider(cfg.cursor);
    case 'claude': return new ClaudeProvider(cfg.claude);
  }
}
export type { AgentProvider, AgentRunRequest, AgentRunResult } from './types.ts';
export { providerBudgetError } from './types.ts';
