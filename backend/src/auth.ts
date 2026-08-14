import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import express from 'express';
import rateLimit from 'express-rate-limit';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { config } from './config.ts';
import { db } from './db.ts';
import {
  INVITE_TTL_MS,
  generateInviteToken,
  hashInviteToken,
  isInviteExpired,
  timingSafeStringEqual,
  validatePassword,
  validateUsername,
} from './validate.ts';

export interface AuthUser {
  id: number;
  username: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends AuthUser {}
  }
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
}

// Hash to verify against when the username doesn't exist, so both paths cost
// the same and login timing can't be used to enumerate accounts.
const dummyHash = await argon2.hash(randomBytes(16).toString('hex'), { type: argon2.argon2id });

const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });

passport.use(
  new LocalStrategy((username, password, done) => {
    (async () => {
      const row = db
        .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
        .get(username) as UserRow | undefined;
      const ok = await argon2.verify(row?.password_hash ?? dummyHash, password);
      if (!row || !ok) return done(null, false);
      done(null, { id: row.id, username: row.username });
    })().catch(done);
  }),
);

passport.serializeUser<number>((user, done) => done(null, user.id));

passport.deserializeUser<number>((id, done) => {
  const row = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id) as
    | AuthUser
    | undefined;
  done(null, row ?? false);
});

export function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Authentication required.' });
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts; try again later.' },
});

/**
 * Returns the inviting user's id (null for the bootstrap invite) if the token
 * is acceptable, or undefined if it isn't. Does not consume the invite.
 */
function checkInviteToken(token: string): { invitedBy: number | null; inviteId: number | null } | undefined {
  const invite = db
    .prepare('SELECT id, created_by, expires_at FROM invites WHERE token_hash = ? AND used_by IS NULL')
    .get(hashInviteToken(token)) as
    | { id: number; created_by: number | null; expires_at: string }
    | undefined;
  if (invite && !isInviteExpired(invite.expires_at)) {
    return { invitedBy: invite.created_by, inviteId: invite.id };
  }

  const userCount = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (
    userCount === 0 &&
    config.bootstrapInviteToken &&
    timingSafeStringEqual(token, config.bootstrapInviteToken)
  ) {
    return { invitedBy: null, inviteId: null };
  }

  return undefined;
}

function loginAndRespond(req: express.Request, res: express.Response, user: AuthUser, status = 200): void {
  req.logIn(user, (err) => {
    if (err) {
      res.status(500).json({ error: 'Failed to establish session.' });
      return;
    }
    res.status(status).json({ id: user.id, username: user.username });
  });
}

export const authRouter = express.Router();

authRouter.post('/api/auth/login', authLimiter, (req, res, next) => {
  const handler = passport.authenticate('local', (err: unknown, user: AuthUser | false) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
    loginAndRespond(req, res, user);
  }) as express.RequestHandler;
  handler(req, res, next);
});

authRouter.post('/api/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => res.json({ ok: true }));
  });
});

authRouter.get('/api/auth/me', (req, res) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  res.json({ id: req.user.id, username: req.user.username });
});

authRouter.post('/api/auth/register', authLimiter, (req, res) => {
  (async () => {
    const { token, username, password } = (req.body ?? {}) as Record<string, unknown>;

    if (typeof token !== 'string' || token.length === 0) {
      res.status(400).json({ error: 'Invalid or expired invite token.' });
      return;
    }
    if (!validateUsername(username)) {
      res.status(400).json({ error: 'Username must be 3-32 characters with no whitespace.' });
      return;
    }
    if (!validatePassword(password)) {
      res.status(400).json({ error: 'Password must be at least 8 characters.' });
      return;
    }

    const invite = checkInviteToken(token);
    if (!invite) {
      res.status(400).json({ error: 'Invalid or expired invite token.' });
      return;
    }

    const passwordHash = await hashPassword(password);

    let user: AuthUser;
    db.exec('BEGIN');
    try {
      const existing = db
        .prepare('SELECT id FROM users WHERE username = ?')
        .get(username) as { id: number } | undefined;
      if (existing) {
        db.exec('ROLLBACK');
        res.status(409).json({ error: 'Username is already taken.' });
        return;
      }
      const result = db
        .prepare('INSERT INTO users (username, password_hash, created_at, invited_by) VALUES (?, ?, ?, ?)')
        .run(username, passwordHash, new Date().toISOString(), invite.invitedBy);
      user = { id: Number(result.lastInsertRowid), username };
      if (invite.inviteId !== null) {
        db.prepare('UPDATE invites SET used_by = ? WHERE id = ?').run(user.id, invite.inviteId);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    loginAndRespond(req, res, user, 201);
  })().catch((err: unknown) => {
    console.error('registration failed:', err);
    res.status(500).json({ error: 'Registration failed.' });
  });
});

authRouter.post('/api/invites', requireAuth, (req, res) => {
  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  db.prepare('INSERT INTO invites (token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashInviteToken(token), req.user!.id, new Date().toISOString(), expiresAt);
  res.status(201).json({ token, expiresAt });
});
