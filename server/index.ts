import { resolve } from 'node:path';
import { createApp } from './app.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required. Configure PostgreSQL before starting signhere.');
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const baseUrl = process.env.BASE_URL ?? 'http://localhost:' + port;
const runtime = await createApp({
  databaseUrl, baseUrl, dataDir: resolve(process.env.DATA_DIR ?? './data'),
  setupToken: process.env.SETUP_TOKEN, migrationDatabaseUrl: process.env.MIGRATION_DATABASE_URL,
  keysDir: process.env.SIGNHERE_KEYS_DIR,
  signingLinkTtlDays: Number(process.env.SIGNHERE_SIGNING_LINK_TTL_DAYS ?? 7),
  sealP12File: process.env.SIGNHERE_SEAL_P12_FILE, sealPasswordFile: process.env.SIGNHERE_SEAL_PASSWORD_FILE,
  trustProxy: process.env.TRUST_PROXY?.split(',').map(value => value.trim()).filter(Boolean),
});
const server = runtime.app.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log('signhere listening on port ' + port));
server.requestTimeout = 60000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 15000).unref();
  server.close(async () => {
    await runtime.close();
    clearTimeout(deadline);
    process.exit(0);
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);


