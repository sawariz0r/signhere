/**
 * Central administration CLI. Run inside the central container:
 *   node dist/server/central/admin.js keys init --service https://signhere.prpl.se
 *   node dist/server/central/admin.js instance create --name "Exempel AB" --origin https://sign.example.se
 * See docs/central-deployment.md.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { createCentralDatabase } from './db.js';
import { createInstance, issueCredential, setInstanceStatus } from './app.js';
import { generateSigner, loadSigner, newBundle, signTrustBundle, trustKey, writeKeyFile, signerFromPrivateKey } from './keys.js';
import { verifyTrustBundle, type TrustBundle } from './protocol.js';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf('--' + name); return index >= 0 ? args[index + 1] : undefined; };
const flag = (name: string) => args.includes('--' + name);
const keysDir = resolve(option('dir') ?? process.env.CENTRAL_KEYS_DIR ?? './central-keys');
const bundleFile = join(keysDir, 'trust-bundle.jws');
const rootFile = option('root') ?? join(keysDir, 'root.pem');
const usage = `Usage:
  keys init --service <origin>        Create trust root, first receipt key and trust bundle
  keys rotate                         New receipt key; previous active key becomes retired (needs root.pem)
  keys revoke <kid> [--at <iso time>] Mark a receipt key compromised from a time (needs root.pem)
  keys show                           Print the bundle and root public key
  instance create --name <name> --origin <origin>
  instance list
  instance key <instanceId> [--revoke-others]
  instance suspend|activate <instanceId>
Options: --dir <keys directory> (default CENTRAL_KEYS_DIR), --root <root.pem path>`;

async function root() {
  if (!existsSync(rootFile)) throw new Error('The trust root private key (' + rootFile + ') is needed for this operation. Bring it back from offline storage temporarily.');
  return loadSigner(rootFile);
}
async function currentBundle(): Promise<{ bundle: TrustBundle; rootPublicKey: string }> {
  const signer = await root();
  return { bundle: await verifyTrustBundle((await readFile(bundleFile, 'utf8')).trim(), signer.publicKey), rootPublicKey: signer.publicKey };
}
async function publish(bundle: TrustBundle) {
  const jws = await signTrustBundle(await root(), bundle);
  await writeFile(bundleFile, jws + '\n', { mode: 0o644 });
  console.log('Wrote ' + bundleFile + ' (sequence ' + bundle.sequence + '). Restart the service and publish the new bundle.');
}

async function keys(command?: string) {
  if (command === 'init') {
    const service = option('service');
    if (!service || new URL(service).origin !== service) throw new Error('--service must be the public origin, e.g. https://signhere.prpl.se');
    if (existsSync(bundleFile)) throw new Error('Keys already exist in ' + keysDir + '.');
    const rootKey = await generateSigner();
    const receipt = await generateSigner();
    await writeKeyFile(keysDir, 'root.pem', rootKey.pem);
    await writeKeyFile(keysDir, 'receipt-' + receipt.signer.kid + '.pem', receipt.pem);
    await publish(newBundle(service, 1, [trustKey(receipt.signer, new Date().toISOString())]));
    console.log(`\nTrust root public key (set CENTRAL_TRUST_ROOT and SIGNHERE_CENTRAL_TRUST_ROOT to this value):\n\n  ${rootKey.signer.publicKey}\n
Next: publish this value through an independent channel (e.g. the Git repository README and a signed release),
then move ${rootFile} to offline storage. The running service does not need it.`);
    return;
  }
  if (command === 'rotate') {
    const { bundle } = await currentBundle();
    const receipt = await generateSigner();
    const at = new Date().toISOString();
    await writeKeyFile(keysDir, 'receipt-' + receipt.signer.kid + '.pem', receipt.pem);
    const keys = bundle.keys.map(key => key.status === 'active' ? { ...key, status: 'retired' as const, validUntil: at } : key);
    await publish(newBundle(bundle.service, bundle.sequence + 1, [...keys, trustKey(receipt.signer, at)], at));
    console.log('New receipt key ' + receipt.signer.kid + '. Retired keys stay listed so old receipts keep verifying.');
    return;
  }
  if (command === 'revoke') {
    const kid = args[2];
    const at = option('at') ?? new Date().toISOString();
    const { bundle } = await currentBundle();
    if (!bundle.keys.some(key => key.kid === kid)) throw new Error('Unknown key id.');
    const keys = bundle.keys.map(key => key.kid === kid ? { ...key, status: 'revoked' as const, revokedAt: new Date(at).toISOString() } : key);
    if (!keys.some(key => key.status === 'active')) console.warn('Warning: no active receipt key remains. Run keys rotate before restarting the service.');
    await publish(newBundle(bundle.service, bundle.sequence + 1, keys));
    return;
  }
  if (command === 'show') {
    const jws = (await readFile(bundleFile, 'utf8')).trim();
    const rootPublicKey = existsSync(rootFile) ? (await signerFromPrivateKey(createPrivateKey(await readFile(rootFile, 'utf8')))).publicKey : process.env.CENTRAL_TRUST_ROOT;
    if (!rootPublicKey) throw new Error('Set CENTRAL_TRUST_ROOT to show a verified bundle.');
    console.log(JSON.stringify({ rootPublicKey, bundle: await verifyTrustBundle(jws, rootPublicKey), receiptKeyFiles: (await readdir(keysDir)).filter(name => name.startsWith('receipt-')) }, null, 2));
    return;
  }
  throw new Error(usage);
}

async function instances(command?: string) {
  const url = process.env.CENTRAL_DATABASE_URL;
  if (!url) throw new Error('CENTRAL_DATABASE_URL is required.');
  const pool = await createCentralDatabase(url, process.env.CENTRAL_DATABASE_SCHEMA ?? 'central');
  try {
    if (command === 'create') {
      const name = option('name'), origin = option('origin');
      if (!name || !origin) throw new Error(usage);
      const result = await createInstance(pool, { name, origin });
      console.log(`Instance ${result.instanceId} created for ${origin}.\n\nAPI key (shown once; give it to the installation as SIGNHERE_CENTRAL_API_KEY_FILE contents):\n\n  ${result.apiKey}\n`);
    } else if (command === 'list') {
      for (const row of (await pool.query('SELECT id,name,origin,status,created_at FROM instances ORDER BY created_at')).rows) console.log([row.id, row.status, row.origin, row.name].join('\t'));
    } else if (command === 'key') {
      const apiKey = await issueCredential(pool, args[2], flag('revoke-others'));
      console.log('New API key (shown once):\n\n  ' + apiKey + '\n');
    } else if (command === 'suspend' || command === 'activate') {
      if (!await setInstanceStatus(pool, args[2], command === 'suspend' ? 'suspended' : 'active')) throw new Error('Unknown instance.');
      console.log('Instance ' + args[2] + ' is now ' + (command === 'suspend' ? 'suspended' : 'active') + '. Issued receipts are unaffected.');
    } else throw new Error(usage);
  } finally { await pool.end(); }
}

try {
  if (args[0] === 'keys') await keys(args[1]);
  else if (args[0] === 'instance') await instances(args[1]);
  else throw new Error(usage);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
