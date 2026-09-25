import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSigner } from './keys.js';
import { verifyTrustBundle } from './protocol.js';

/**
 * Key directory layout:
 *   trust-bundle.jws       published bundle, signed by the offline trust root
 *   receipt-<kid>.pem      approval-receipt private keys (0600)
 *   root.pem               trust root private key; only present while running admin commands
 * The running service needs the bundle, the active receipt key, and the root PUBLIC key
 * (CENTRAL_TRUST_ROOT) to check that its own bundle is authentic.
 */
export async function loadServiceKeys(keysDir: string, rootPublicKey: string) {
  const jws = (await readFile(join(keysDir, 'trust-bundle.jws'), 'utf8')).trim();
  const bundle = await verifyTrustBundle(jws, rootPublicKey);
  const active = bundle.keys.filter(key => key.status === 'active' && key.purposes.includes('approval-receipt'))
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
  if (!active) throw new Error('The trust bundle has no active approval-receipt key.');
  const signer = await loadSigner(join(keysDir, 'receipt-' + active.kid + '.pem'));
  if (signer.kid !== active.kid) throw new Error('Receipt key file does not match the trust bundle.');
  return { signer, trustBundle: { jws, bundle, rootPublicKey } };
}
