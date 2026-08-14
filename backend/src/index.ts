import path from 'node:path';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { authRouter, requireAuth } from './auth.ts';
import { config } from './config.ts';
import { eventsRouter } from './events-api.ts';
import { SqliteSessionStore } from './session-store.ts';
import { webhookRouter } from './webhook.ts';

const app = express();
const clientDist = path.join(import.meta.dirname, '..', '..', 'client', 'dist');

// Behind a TLS-terminating reverse proxy in production.
app.set('trust proxy', 1);

// Mounted before express.json() (needs the raw body for HMAC verification) and
// before the session/auth middleware (authenticated by signature, not session).
app.use(webhookRouter);

app.use(express.json());

app.use(
  session({
    store: new SqliteSessionStore(),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // Secure only when the request came in over TLS (via the reverse proxy's
      // X-Forwarded-Proto) — lets local Docker testing work over plain http.
      secure: 'auto',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);
app.use(passport.initialize());
app.use(passport.session());

// Default-deny: every /api route requires a session unless allowlisted here.
const publicApiPaths = new Set(['/api/health', '/api/auth/login', '/api/auth/register']);
app.use('/api', (req, res, next) => {
  if (publicApiPaths.has(req.originalUrl.split('?')[0] ?? '')) return next();
  requireAuth(req, res, next);
});

app.use(authRouter);
app.use(eventsRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use(express.static(clientDist));

// SPA fallback: send index.html for any non-API GET request
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
});
