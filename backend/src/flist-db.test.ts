import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapSubscribed } from './flist-db.ts';

describe('mapSubscribed', () => {
  it('maps F-List fakebool values to the tri-state cache', () => {
    assert.equal(mapSubscribed('1'), 1);
    assert.equal(mapSubscribed('0'), 0);
    assert.equal(mapSubscribed(1), 1);
    assert.equal(mapSubscribed(0), 0);
  });

  it('treats absence/unknown as null', () => {
    assert.equal(mapSubscribed(null), null);
    assert.equal(mapSubscribed(undefined), null);
    assert.equal(mapSubscribed(''), null);
    assert.equal(mapSubscribed('yes'), null);
    assert.equal(mapSubscribed(2), null);
  });
});
