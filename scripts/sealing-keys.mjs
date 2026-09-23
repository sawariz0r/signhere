import { resolve, join } from 'node:path';
import { createDatabase } from '../dist/server/db.js';
import { createKeyStore } from '../dist/server/key-store.js';
import { retryFinalization } from '../dist/server/finalization.js';
const [command = 'status', documentId] = process.argv.slice(2);
if (!['status', 'rotate', 'recover-lost-key', 'retry-with-current-key'].includes(command)) throw new Error('Usage: npm run sealing:keys -- status|rotate|recover-lost-key|retry-with-current-key DOCUMENT_UUID');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const db = await createDatabase(process.env.DATABASE_URL, 'public', process.env.MIGRATION_DATABASE_URL);
try {
  const keys = await createKeyStore(db, { keysDir: process.env.SIGNHERE_KEYS_DIR ?? join(resolve(process.env.DATA_DIR ?? './data'), 'keys'), p12File: process.env.SIGNHERE_SEAL_P12_FILE, passwordFile: process.env.SIGNHERE_SEAL_PASSWORD_FILE });
  if (command === 'retry-with-current-key') {
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(documentId ?? '')) throw new Error('Provide the exact document UUID to recover.');
    if (!(await keys.refresh()).ready) throw new Error('The current sealing identity is not usable.');
    const retried = await retryFinalization(db, documentId, { resetSigningIdentity: true });
    if (!retried) throw new Error('No action-required finalization exists for that document.');
    console.log(JSON.stringify({ retried: true, documentId, note: 'The retry explicitly adopts the current sealing identity; accepted signatures and protection policy are unchanged.' }));
  } else {
    const status = command === 'status' ? await keys.refresh() : await keys.rotate(command === 'recover-lost-key' ? 'lost-key' : 'rotation');
    console.log(JSON.stringify(status, null, 2));
    if (!status.ready) process.exitCode = 1;
    if (command !== 'status') console.log('Prior certificate trust pins do not automatically trust this replacement. Publish the new fingerprint through your trusted channel; preserve historical public certificates.');
  }
} finally { await db.end(); }
