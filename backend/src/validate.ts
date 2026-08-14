import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** SubscribeStar signs webhook bodies with hex(hmac_md5(secret, raw bytes)). */
export function signBody(secret: string, rawBody: Buffer | string): string {
  return createHmac('md5', secret).update(rawBody).digest('hex');
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isInviteExpired(expiresAt: string, now: Date = new Date()): boolean {
  return new Date(expiresAt).getTime() < now.getTime();
}

export function validateUsername(username: unknown): username is string {
  return (
    typeof username === 'string' &&
    username.length >= 3 &&
    username.length <= 32 &&
    !/[\s\p{Cc}]/u.test(username)
  );
}

export function validatePassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 1024;
}
