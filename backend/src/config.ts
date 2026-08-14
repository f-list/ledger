import { randomBytes } from 'node:crypto';

const isProduction = process.env.NODE_ENV === 'production';

function sessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) return fromEnv;
  if (isProduction) {
    console.error('SESSION_SECRET must be set in production');
    process.exit(1);
  }
  console.warn('SESSION_SECRET not set; using an ephemeral secret (dev only, sessions reset on restart)');
  return randomBytes(32).toString('hex');
}

export const config = {
  isProduction,
  port: Number(process.env.PORT) || 3000,
  dbPath: process.env.DB_PATH || 'data/ledger.db',
  sessionSecret: sessionSecret(),
  bootstrapInviteToken: process.env.BOOTSTRAP_INVITE_TOKEN,
};
