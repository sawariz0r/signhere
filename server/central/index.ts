import { resolve } from 'node:path';
import { mailerFromEnv } from '../mail.js';
import { createCentralApp } from './app.js';
import { loadServiceKeys } from './key-files.js';

/** The central service reuses the installation's mail settings under a CENTRAL_ prefix. */
function centralMailEnv(env: NodeJS.ProcessEnv) {
  const mapped: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) if (key.startsWith('CENTRAL_MAIL_')) mapped[key.slice('CENTRAL_MAIL_'.length)] = value;
  return mapped;
}
const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(name + ' is required.'); return value; };
const origin = required('CENTRAL_ORIGIN');
const keys = await loadServiceKeys(resolve(process.env.CENTRAL_KEYS_DIR ?? './central-keys'), required('CENTRAL_TRUST_ROOT'));
const mailer = mailerFromEnv(centralMailEnv(process.env));
if (!mailer) throw new Error('The central service needs e-mail: set CENTRAL_MAIL_SMTP_URL (or CENTRAL_MAIL_SMTP_HOST ...) and CENTRAL_MAIL_SIGNHERE_MAIL_FROM.');
const port = Number(process.env.PORT ?? 3100);
const runtime = await createCentralApp({
  databaseUrl: required('CENTRAL_DATABASE_URL'), schema: process.env.CENTRAL_DATABASE_SCHEMA ?? 'central', origin, ...keys, mailer,
  webDir: process.env.CENTRAL_WEB_DIR, retentionDays: process.env.CENTRAL_RETENTION_DAYS ? Number(process.env.CENTRAL_RETENTION_DAYS) : undefined,
  trustProxy: process.env.TRUST_PROXY?.split(',').map(value => value.trim()).filter(Boolean),
});
console.log('signhere-central: receipt key ' + keys.signer.kid + ', mail via ' + mailer.provider);
const server = runtime.app.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log('signhere-central listening on port ' + port));
server.requestTimeout = 30000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
const stop = () => { server.close(async () => { await runtime.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
