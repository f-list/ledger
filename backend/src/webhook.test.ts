import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signBody, timingSafeStringEqual } from './validate.ts';

describe('signBody', () => {
  it('matches an independently computed HMAC-MD5 hex digest', () => {
    // Precomputed: hex(hmac_md5("test-secret", '{"a":1}'))
    assert.equal(signBody('test-secret', '{"a":1}'), 'c55a9d966cfa2294413455b0ca40e21f');
  });

  it('changes when a single body byte changes', () => {
    assert.notEqual(signBody('test-secret', '{"a":1}'), signBody('test-secret', '{"a":2}'));
  });

  it('changes with the secret', () => {
    assert.notEqual(signBody('test-secret', '{"a":1}'), signBody('other-secret', '{"a":1}'));
  });

  it('operates on bytes, not re-serialized JSON', () => {
    // Same JSON value, different bytes — signatures must differ.
    assert.notEqual(signBody('test-secret', '{"a":1}'), signBody('test-secret', '{"a": 1}'));
  });
});

describe('timingSafeStringEqual', () => {
  it('compares correctly across lengths and contents', () => {
    assert.equal(timingSafeStringEqual('abc', 'abc'), true);
    assert.equal(timingSafeStringEqual('abc', 'abd'), false);
    assert.equal(timingSafeStringEqual('abc', 'abcd'), false);
    assert.equal(timingSafeStringEqual('', ''), true);
  });
});
