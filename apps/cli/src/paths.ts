import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env.IDLEHAND_HOME ?? join(homedir(), '.idlehand');
export const CONFIG_PATH = join(HOME, 'config.json');
export const STATE_PATH = join(HOME, 'state.sqlite');
export const REPOS_DIR = join(HOME, 'repos');
export const WORK_DIR = join(HOME, 'work');
export const LOGS_DIR = join(HOME, 'logs');
