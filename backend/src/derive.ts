/**
 * Pure parsing/derivation logic for SubscribeStar webhook events. No I/O.
 *
 * Live payloads deviate from SubscribeStar's docs (see docs/0-subscriber-ledger.md §2),
 * so everything here parses defensively: unknown shapes yield nulls, never throws.
 */

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {};
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function idOrNull(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  return asStringOrNull(value);
}

export interface Envelope {
  eventType: string | null;
  eventTs: number | null;
  requestId: string | null;
  attempt: number;
  subscriberId: string | null;
}

export function parseEnvelope(raw: string): Envelope {
  let body: Json;
  try {
    body = asObject(JSON.parse(raw));
  } catch {
    body = {};
  }
  const payload = asObject(body.payload);
  const subscription = asObject(payload.subscription);
  const subscriber = asObject(payload.subscriber);
  const payment = asObject(payload.payment);
  const pledger = asObject(payload.pledger);

  return {
    eventType: asStringOrNull(body.event),
    eventTs: asNumberOrNull(body.timestamp),
    requestId: asStringOrNull(body.request_id),
    // Live events carry `attempts`; the settings-page test payload also has `attempt`.
    attempt: asNumberOrNull(body.attempts) ?? asNumberOrNull(body.attempt) ?? 1,
    subscriberId:
      idOrNull(subscription.subscriber_id) ??
      idOrNull(subscriber.id) ??
      idOrNull(payment.subscriber_id) ??
      idOrNull(pledger.id),
  };
}

/** Dedupe key for the events table when the envelope lacks a request_id. */
export function fallbackDedupeKey(raw: string, envelope: Envelope): string {
  let subscriptionId = 'none';
  try {
    const payload = asObject(asObject(JSON.parse(raw)).payload);
    subscriptionId =
      idOrNull(asObject(payload.subscription).id) ??
      idOrNull(asObject(payload.payment).id) ??
      'none';
  } catch {
    // fall through
  }
  return `fallback:${envelope.eventType ?? 'unknown'}:${subscriptionId}:${envelope.eventTs ?? 0}`;
}

const ADDRESS_KEY_PATTERN = /address|street|city|state|zip|postal|country|phone|full_name/i;

function withoutAddressKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAddressKeys);
  if (typeof value !== 'object' || value === null) return value;
  const result: Json = {};
  for (const [key, entry] of Object.entries(value)) {
    if (ADDRESS_KEY_PATTERN.test(key)) continue;
    result[key] = withoutAddressKeys(entry);
  }
  return result;
}

/**
 * For shipping-address events, drop the address itself before storage: the
 * event's occurrence is recorded, the PII is not. Other events pass through
 * untouched. Call only after signature verification (which needs exact bytes).
 */
export function stripShippingAddress(raw: string, eventType: string | null): string {
  if (!eventType?.startsWith('shipping_address_')) return raw;
  try {
    return JSON.stringify(withoutAddressKeys(JSON.parse(raw)));
  } catch {
    return raw;
  }
}

export interface DisplayFields {
  nickname: string | null;
  tierId: string | null;
  costCents: number | null;
}

/** Display fields for the ledger UI — extracted server-side so the raw payload never leaves the backend. */
export function extractDisplayFields(raw: string): DisplayFields {
  let body: Json;
  try {
    body = asObject(JSON.parse(raw));
  } catch {
    return { nickname: null, tierId: null, costCents: null };
  }
  const payload = asObject(body.payload);
  const subscription = asObject(payload.subscription);
  const payment = asObject(payload.payment);
  const person = asObject(
    Object.keys(asObject(payload.subscriber)).length > 0 ? payload.subscriber : payload.pledger,
  );
  return {
    nickname: asStringOrNull(person.nickname),
    tierId: idOrNull(subscription.tier_id) ?? idOrNull(payment.tier_id),
    costCents: asNumberOrNull(subscription.cost) ?? asNumberOrNull(payment.amount),
  };
}

const SUBSCRIPTION_EVENTS = new Set([
  'new_subscription',
  'subscription_cancelled',
  'subscription_restored',
  'subscription_billing_failed',
  'recurring_pledge_increased',
  'recurring_pledge_decreased',
]);

const PAYMENT_EVENTS = new Set(['payment_succeed', 'payment_disputed']);

const PASSIVE_EVENTS = new Set([
  'email_shared',
  'email_unshared',
  'shipping_address_shared',
  'shipping_address_unshared',
]);

export function isKnownEventType(eventType: string | null): boolean {
  return (
    eventType !== null &&
    (SUBSCRIPTION_EVENTS.has(eventType) || PAYMENT_EVENTS.has(eventType) || PASSIVE_EVENTS.has(eventType))
  );
}

export interface StoredEvent {
  event_type: string;
  event_ts: number;
  raw: string;
}

export interface SubscriberState {
  status: 'active' | 'cancelled' | 'billing_failed' | 'paused' | 'unknown';
  tierId: string | null;
  costCents: number | null;
  nickname: string | null;
  email: string | null;
  lastEventTs: number | null;
  /** Timestamp of the last status *transition* — payment/passive events never move it. */
  statusChangedTs: number | null;
}

/**
 * Fold a subscriber's events (any arrival order) into their current state.
 * Sorted by the payload timestamp — never arrival order (deliveries can be
 * out of order). Each subscription event carries a full snapshot, so the
 * newest one wins; the fold handles interleaved payment/passive events.
 */
export function deriveSubscriber(events: StoredEvent[]): SubscriberState {
  const state: SubscriberState = {
    status: 'unknown',
    tierId: null,
    costCents: null,
    nickname: null,
    email: null,
    lastEventTs: null,
    statusChangedTs: null,
  };

  const sorted = [...events].sort((a, b) => a.event_ts - b.event_ts);

  for (const event of sorted) {
    const statusBefore = state.status;
    let body: Json;
    try {
      body = asObject(JSON.parse(event.raw));
    } catch {
      continue;
    }
    const payload = asObject(body.payload);
    const eventType = event.event_type;

    state.lastEventTs = event.event_ts;

    // Person fields: `subscriber` on subscription events, `pledger` on payment events.
    const person = asObject(
      Object.keys(asObject(payload.subscriber)).length > 0 ? payload.subscriber : payload.pledger,
    );
    state.nickname = asStringOrNull(person.nickname) ?? state.nickname;
    if (eventType === 'email_unshared') {
      state.email = null;
    } else {
      state.email = asStringOrNull(person.email) ?? state.email;
    }

    if (SUBSCRIPTION_EVENTS.has(eventType)) {
      const subscription = asObject(payload.subscription);
      state.tierId = idOrNull(subscription.tier_id) ?? state.tierId;
      state.costCents = asNumberOrNull(subscription.cost) ?? state.costCents;
      if (subscription.cancelled === true) state.status = 'cancelled';
      else if (subscription.paused === true) state.status = 'paused';
      else if (subscription.billing_failed === true) state.status = 'billing_failed';
      else state.status = 'active';
    } else if (PAYMENT_EVENTS.has(eventType)) {
      const payment = asObject(payload.payment);
      state.tierId = idOrNull(payment.tier_id) ?? state.tierId;
    }
    // Passive and unknown event types never change status.

    if (state.status !== statusBefore) state.statusChangedTs = event.event_ts;
  }

  return state;
}
