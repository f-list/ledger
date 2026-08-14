import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generateInviteToken,
  hashInviteToken,
  isInviteExpired,
  validatePassword,
  validateTierId,
  validateTierName,
  validateUsername,
} from './validate.ts';

describe('invite tokens', () => {
  it('generates unique url-safe tokens', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically and irreversibly', () => {
    const token = generateInviteToken();
    assert.equal(hashInviteToken(token), hashInviteToken(token));
    assert.match(hashInviteToken(token), /^[0-9a-f]{64}$/);
    assert.notEqual(hashInviteToken(token), hashInviteToken(token + 'x'));
  });

  it('detects expiry', () => {
    const now = new Date('2026-08-14T12:00:00Z');
    assert.equal(isInviteExpired('2026-08-14T11:59:59Z', now), true);
    assert.equal(isInviteExpired('2026-08-14T12:00:01Z', now), false);
  });
});

describe('validateUsername', () => {
  it('accepts 3-32 char names without whitespace', () => {
    assert.equal(validateUsername('abc'), true);
    assert.equal(validateUsername('Sindrake'), true);
    assert.equal(validateUsername('a'.repeat(32)), true);
  });

  it('rejects bad input', () => {
    assert.equal(validateUsername('ab'), false);
    assert.equal(validateUsername('a'.repeat(33)), false);
    assert.equal(validateUsername('has space'), false);
    assert.equal(validateUsername('tab\there'), false);
    assert.equal(validateUsername('ctrl\u0000char'), false);
    assert.equal(validateUsername(42), false);
    assert.equal(validateUsername(undefined), false);
  });
});

describe('validatePassword', () => {
  it('enforces length bounds', () => {
    assert.equal(validatePassword('12345678'), true);
    assert.equal(validatePassword('1234567'), false);
    assert.equal(validatePassword('x'.repeat(1025)), false);
    assert.equal(validatePassword(null), false);
  });
});

describe('validateTierId', () => {
  it('accepts numeric ids only', () => {
    assert.equal(validateTierId('101735'), true);
    assert.equal(validateTierId('1'), true);
    assert.equal(validateTierId(''), false);
    assert.equal(validateTierId('101735x'), false);
    assert.equal(validateTierId('../users'), false);
    assert.equal(validateTierId(101735), false);
  });
});

describe('validateTierName', () => {
  it('requires 1-64 chars after trimming', () => {
    assert.equal(validateTierName('Basic'), true);
    assert.equal(validateTierName('  Basic  '), true);
    assert.equal(validateTierName('   '), false);
    assert.equal(validateTierName('x'.repeat(65)), false);
    assert.equal(validateTierName(undefined), false);
  });
});
