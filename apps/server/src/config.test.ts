import { describe, expect, test } from 'bun:test';
import { configFromEnv } from './config.ts';

const secret = 'test-session-secret-at-least-32-chars';

describe('configFromEnv', () => {
  test('refuses IDLEHAND_DEV_LOGIN in NODE_ENV=production', () => {
    expect(() => configFromEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: secret,
      IDLEHAND_DEV_LOGIN: '1',
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
    })).toThrow(/IDLEHAND_DEV_LOGIN/);
  });

  test('refuses IDLEHAND_DEV_LOGIN when BASE_URL is https', () => {
    expect(() => configFromEnv({
      BASE_URL: 'https://idlehand.example',
      SESSION_SECRET: secret,
      IDLEHAND_DEV_LOGIN: '1',
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
    })).toThrow(/IDLEHAND_DEV_LOGIN/);
  });

  test('enables dev login in non-production', () => {
    const cfg = configFromEnv({
      BASE_URL: 'http://localhost:8787',
      SESSION_SECRET: secret,
      IDLEHAND_DEV_LOGIN: '1',
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
    });
    expect(cfg.devLogin).toBe(true);
  });
});
