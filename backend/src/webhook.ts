import express from 'express';
import { config } from './config.ts';
import { db } from './db.ts';
import {
  deriveSubscriber,
  fallbackDedupeKey,
  isKnownEventType,
  parseEnvelope,
  stripShippingAddress,
  type StoredEvent,
} from './derive.ts';
import { signBody, timingSafeStringEqual } from './validate.ts';

const insertEvent = db.prepare(
  `INSERT INTO events (received_at, event_type, event_ts, subscriber_id, attempt, raw, request_id)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(request_id) DO NOTHING`,
);

const selectSubscriberEvents = db.prepare(
  'SELECT event_type, event_ts, raw FROM events WHERE subscriber_id = ? ORDER BY event_ts',
);

// Derivation never touches the manual columns (flist_account, notes, seeded).
const upsertSubscriber = db.prepare(
  `INSERT INTO subscribers (subscriber_id, status, tier_id, cost_cents, nickname, email, last_event_ts, status_changed_ts)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(subscriber_id) DO UPDATE SET
     status = excluded.status,
     tier_id = excluded.tier_id,
     cost_cents = excluded.cost_cents,
     nickname = excluded.nickname,
     email = excluded.email,
     last_event_ts = excluded.last_event_ts,
     status_changed_ts = excluded.status_changed_ts`,
);

export function rederiveSubscriber(subscriberId: string): void {
  const events = selectSubscriberEvents.all(subscriberId) as unknown as StoredEvent[];
  const state = deriveSubscriber(events);
  upsertSubscriber.run(
    subscriberId,
    state.status,
    state.tierId,
    state.costCents,
    state.nickname,
    state.email,
    state.lastEventTs,
    state.statusChangedTs,
  );
}

export const webhookRouter = express.Router();

webhookRouter.post(
  '/api/webhook/:token',
  express.raw({ type: () => true, limit: '256kb' }),
  (req, res) => {
    if (!timingSafeStringEqual(req.params.token, config.webhookPathToken)) {
      // Indistinguishable from a nonexistent route.
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = req.get('x-subscribestar-signature') ?? '';
    if (!timingSafeStringEqual(signature, signBody(config.webhookSecret, rawBody))) {
      console.warn(`webhook: bad signature from ${req.ip ?? 'unknown'}`);
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Store the raw event first; everything after the insert must not affect the
    // 200 — the raw row is the source of truth and can be re-processed.
    const raw = rawBody.toString('utf8');
    const envelope = parseEnvelope(raw);
    const stored = stripShippingAddress(raw, envelope.eventType);

    try {
      const result = insertEvent.run(
        new Date().toISOString(),
        envelope.eventType ?? 'unknown',
        envelope.eventTs ?? 0,
        envelope.subscriberId,
        envelope.attempt,
        stored,
        envelope.requestId ?? fallbackDedupeKey(raw, envelope),
      );
      if (result.changes === 0) {
        console.info(`webhook: duplicate delivery ignored (${envelope.requestId ?? 'no request_id'})`);
        res.json({ ok: true, duplicate: true });
        return;
      }
    } catch (err) {
      console.error('webhook: failed to store event:', err);
      res.status(500).json({ error: 'Storage failure' });
      return;
    }

    if (!isKnownEventType(envelope.eventType)) {
      console.warn(`webhook: unknown event type "${envelope.eventType ?? 'unparseable'}" stored without derivation`);
    } else if (envelope.subscriberId !== null) {
      try {
        rederiveSubscriber(envelope.subscriberId);
      } catch (err) {
        console.error(`webhook: derivation failed for subscriber ${envelope.subscriberId} (event stored):`, err);
      }
    } else {
      console.warn(`webhook: event "${envelope.eventType}" has no subscriber id; stored without derivation`);
    }

    console.info(
      `webhook: stored ${envelope.eventType ?? 'unknown'} for subscriber ${envelope.subscriberId ?? '?'} (${envelope.requestId ?? 'no request_id'})`,
    );
    res.json({ ok: true });
  },
);
