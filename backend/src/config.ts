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

function requiredInProduction(name: string, devFallback: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  if (isProduction) {
    console.error(`${name} must be set in production`);
    process.exit(1);
  }
  console.warn(`${name} not set; using dev fallback "${devFallback}"`);
  return devFallback;
}

export const config = {
  isProduction,
  port: Number(process.env.PORT) || 3000,
  dbPath: process.env.DB_PATH || 'data/ledger.db',
  sessionSecret: sessionSecret(),
  bootstrapInviteToken: process.env.BOOTSTRAP_INVITE_TOKEN,
  webhookSecret: requiredInProduction('WEBHOOK_SECRET', 'dev-webhook-secret'),
  webhookPathToken: requiredInProduction('WEBHOOK_PATH_TOKEN', 'dev'),
};
