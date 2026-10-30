import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export const SESSION_COOKIE = 'idlehand_session';
export const STATE_COOKIE = 'idlehand_oauth_state';

const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(u8).toString('base64url');
}

export async function signValue(secret: string, value: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return `${value}.${b64url(sig)}`;
}

export async function verifyValue(secret: string, signed: string | undefined): Promise<string | null> {
  if (!signed) return null;
  const idx = signed.lastIndexOf('.');
  if (idx <= 0) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const key = await hmacKey(secret);
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    const raw = Buffer.from(sig, 'base64url');
    sigBytes = new Uint8Array(new ArrayBuffer(raw.length));
    sigBytes.set(raw);
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(value));
  return ok ? value : null;
}

export interface SessionOpts {
  secret: string;
  secure: boolean;
}

export async function setSession(c: Context, opts: SessionOpts, userId: number): Promise<void> {
  const payload = `${userId}:${Date.now()}`;
  setCookie(c, SESSION_COOKIE, await signValue(opts.secret, payload), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: opts.secure,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function readSessionUserId(c: Context, opts: SessionOpts): Promise<number | null> {
  const value = await verifyValue(opts.secret, getCookie(c, SESSION_COOKIE));
  if (!value) return null;
  const id = Number(value.split(':')[0]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function clearSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function newState(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

export async function setStateCookie(c: Context, opts: SessionOpts, state: string, next: string): Promise<void> {
  setCookie(c, STATE_COOKIE, await signValue(opts.secret, `${state}|${next}`), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: opts.secure,
    path: '/',
    maxAge: 600,
  });
}

export async function readStateCookie(c: Context, opts: SessionOpts): Promise<{ state: string; next: string } | null> {
  const value = await verifyValue(opts.secret, getCookie(c, STATE_COOKIE));
  deleteCookie(c, STATE_COOKIE, { path: '/' });
  if (!value) return null;
  const idx = value.indexOf('|');
  if (idx < 0) return null;
  return { state: value.slice(0, idx), next: value.slice(idx + 1) };
}

/** Only allow relative, same-site redirects. */
export function safeNext(next: string | undefined | null, fallback = '/dashboard'): string {
  if (!next) return fallback;
  if (!next.startsWith('/') || next.startsWith('//')) return fallback;
  return next;
}
