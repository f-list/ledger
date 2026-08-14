import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveSubscriber,
  fallbackDedupeKey,
  isKnownEventType,
  parseEnvelope,
  stripShippingAddress,
  type StoredEvent,
} from './derive.ts';

// Fixtures modeled on real captures (docs/webhooks/), sanitized.
function subscriptionEvent(
  event: string,
  ts: number,
  flags: Partial<{ cancelled: boolean; paused: boolean; billing_failed: boolean }> = {},
  overrides: Partial<{ cost: number; tier_id: number; email: string | null }> = {},
): StoredEvent {
  const raw = JSON.stringify({
    attempts: 1,
    payload: {
      subscription: {
        id: 4490347,
        tier_id: overrides.tier_id ?? 101735,
        cost: overrides.cost ?? 299,
        subscriber_id: 2895510,
        billing_failed: flags.billing_failed ?? false,
        cancelled: flags.cancelled ?? false,
        paused: flags.paused ?? false,
        trusted: false,
      },
      subscriber: { email: overrides.email ?? 'sub@example.com', nickname: 'TestSub', id: 2895510 },
    },
    event,
    project: 'subscribestar_adult',
    timestamp: ts,
    request_id: `req-${event}-${ts}`,
  });
  return { event_type: event, event_ts: ts, raw };
}

function paymentEvent(ts: number): StoredEvent {
  const raw = JSON.stringify({
    attempts: 1,
    payload: {
      payment: {
        id: 25247305,
        amount: 299,
        settlement_amount: 216,
        subscriber_id: 2895510,
        subscription_id: 4490347,
        type: 'subscription_fee',
        tier_id: 101735,
      },
      pledger: { email: 'sub@example.com', nickname: 'TestSub', id: 2895510, pledger_type: 'subscriber' },
    },
    event: 'payment_succeed',
    project: 'subscribestar_adult',
    timestamp: ts,
    request_id: `req-payment-${ts}`,
  });
  return { event_type: 'payment_succeed', event_ts: ts, raw };
}

describe('parseEnvelope', () => {
  it('parses a live-shaped subscription event', () => {
    const event = subscriptionEvent('new_subscription', 1000);
    const envelope = parseEnvelope(event.raw);
    assert.equal(envelope.eventType, 'new_subscription');
    assert.equal(envelope.eventTs, 1000);
    assert.equal(envelope.requestId, 'req-new_subscription-1000');
    assert.equal(envelope.attempt, 1);
    assert.equal(envelope.subscriberId, '2895510');
  });

  it('finds the subscriber id in payment events via payload.payment/pledger', () => {
    const envelope = parseEnvelope(paymentEvent(2000).raw);
    assert.equal(envelope.subscriberId, '2895510');
  });

  it('prefers attempts (live) but accepts attempt (test payload)', () => {
    assert.equal(parseEnvelope('{"attempts": 3, "attempt": 1}').attempt, 3);
    assert.equal(parseEnvelope('{"attempt": 2}').attempt, 2);
  });

  it('never throws on garbage', () => {
    const envelope = parseEnvelope('not json at all');
    assert.equal(envelope.eventType, null);
    assert.equal(envelope.subscriberId, null);
    assert.equal(envelope.attempt, 1);
    assert.equal(parseEnvelope('[1,2,3]').eventType, null);
  });
});

describe('fallbackDedupeKey', () => {
  it('builds a stable key from event, subscription id, and timestamp', () => {
    const event = subscriptionEvent('subscription_cancelled', 5000);
    const envelope = parseEnvelope(event.raw);
    assert.equal(fallbackDedupeKey(event.raw, envelope), 'fallback:subscription_cancelled:4490347:5000');
  });

  it('degrades gracefully on garbage', () => {
    const envelope = parseEnvelope('garbage');
    assert.equal(fallbackDedupeKey('garbage', envelope), 'fallback:unknown:none:0');
  });
});

describe('stripShippingAddress', () => {
  const shippingRaw = JSON.stringify({
    event: 'shipping_address_shared',
    payload: {
      subscriber: { id: 1, nickname: 'TestSub' },
      shipping_address: { street_address: '1 Main St', city: 'Portland', zip: '97201', country: 'US' },
    },
    timestamp: 1,
  });

  it('removes address-ish keys recursively for shipping events', () => {
    const stripped = JSON.parse(stripShippingAddress(shippingRaw, 'shipping_address_shared')) as {
      event: string;
      payload: { subscriber?: unknown; shipping_address?: unknown };
    };
    assert.equal(stripped.event, 'shipping_address_shared');
    assert.deepEqual(stripped.payload.subscriber, { id: 1, nickname: 'TestSub' });
    assert.equal(stripped.payload.shipping_address, undefined);
  });

  it('leaves other events byte-identical', () => {
    const event = subscriptionEvent('new_subscription', 1);
    assert.equal(stripShippingAddress(event.raw, 'new_subscription'), event.raw);
  });
});

describe('isKnownEventType', () => {
  it('classifies documented types and rejects others', () => {
    assert.equal(isKnownEventType('new_subscription'), true);
    assert.equal(isKnownEventType('payment_disputed'), true);
    assert.equal(isKnownEventType('email_unshared'), true);
    assert.equal(isKnownEventType('mystery_event'), false);
    assert.equal(isKnownEventType(null), false);
  });
});

describe('deriveSubscriber', () => {
  it('derives active state from a new subscription', () => {
    const state = deriveSubscriber([subscriptionEvent('new_subscription', 1000)]);
    assert.equal(state.status, 'active');
    assert.equal(state.tierId, '101735');
    assert.equal(state.costCents, 299);
    assert.equal(state.nickname, 'TestSub');
    assert.equal(state.email, 'sub@example.com');
    assert.equal(state.lastEventTs, 1000);
  });

  it('follows the real captured lifecycle: subscribe, cancel, resubscribe via restored', () => {
    const events = [
      paymentEvent(1000),
      subscriptionEvent('new_subscription', 1001),
      subscriptionEvent('subscription_cancelled', 2000, { cancelled: true }),
      paymentEvent(3000),
      subscriptionEvent('subscription_restored', 3001),
    ];
    assert.equal(deriveSubscriber(events.slice(0, 3)).status, 'cancelled');
    assert.equal(deriveSubscriber(events).status, 'active');
  });

  it('is insensitive to arrival order', () => {
    const events = [
      subscriptionEvent('new_subscription', 1001),
      subscriptionEvent('subscription_cancelled', 2000, { cancelled: true }),
      subscriptionEvent('subscription_restored', 3001),
    ];
    const shuffled = [events[2], events[0], events[1]];
    assert.deepEqual(deriveSubscriber(shuffled), deriveSubscriber(events));
    assert.equal(deriveSubscriber(shuffled).status, 'active');
  });

  it('maps billing_failed and paused flags to their statuses', () => {
    assert.equal(
      deriveSubscriber([subscriptionEvent('subscription_billing_failed', 1, { billing_failed: true })]).status,
      'billing_failed',
    );
    assert.equal(deriveSubscriber([subscriptionEvent('new_subscription', 1, { paused: true })]).status, 'paused');
  });

  it('payment-only renewal updates last_event_ts but not status', () => {
    const events = [
      subscriptionEvent('new_subscription', 1000),
      paymentEvent(2000), // monthly renewal may fire payment_succeed alone
    ];
    const state = deriveSubscriber(events);
    assert.equal(state.status, 'active');
    assert.equal(state.lastEventTs, 2000);
  });

  it('a payment event alone never invents a status', () => {
    assert.equal(deriveSubscriber([paymentEvent(1000)]).status, 'unknown');
  });

  it('email_unshared clears the email', () => {
    const unshare: StoredEvent = {
      event_type: 'email_unshared',
      event_ts: 2000,
      raw: JSON.stringify({
        event: 'email_unshared',
        payload: { subscriber: { id: 2895510, nickname: 'TestSub' } },
        timestamp: 2000,
      }),
    };
    const state = deriveSubscriber([subscriptionEvent('new_subscription', 1000), unshare]);
    assert.equal(state.email, null);
    assert.equal(state.status, 'active');
  });

  it('unknown event types never change status', () => {
    const mystery: StoredEvent = {
      event_type: 'mystery_event',
      event_ts: 3000,
      raw: JSON.stringify({ event: 'mystery_event', payload: {}, timestamp: 3000 }),
    };
    const state = deriveSubscriber([subscriptionEvent('new_subscription', 1000), mystery]);
    assert.equal(state.status, 'active');
    assert.equal(state.lastEventTs, 3000);
  });

  it('handles pledge changes as snapshots', () => {
    const state = deriveSubscriber([
      subscriptionEvent('new_subscription', 1000, {}, { cost: 299 }),
      subscriptionEvent('recurring_pledge_increased', 2000, {}, { cost: 1000, tier_id: 200000 }),
    ]);
    assert.equal(state.status, 'active');
    assert.equal(state.costCents, 1000);
    assert.equal(state.tierId, '200000');
  });
});
