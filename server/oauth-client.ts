import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { z } from 'zod';
import { ApiError } from './security.js';

export type OAuthMetadataLoader = (url: string) => Promise<unknown>;
export function chatGPTClientId(value: string) {
  if (!/^https:\/\/chatgpt\.com\/oauth\/(?:[A-Za-z0-9_-]{1,128}\/)?client\.json$/.test(value)) throw new ApiError(400, 'Only official ChatGPT client metadata is supported.');
  return value;
}
function publicAddress(address: string) {
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address);
  const parts = address.split('.').map(Number);
  return parts.length === 4 && ![0, 10, 127].includes(parts[0]) && parts[0] < 224 && !(parts[0] === 169 && parts[1] === 254) && !(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) && !(parts[0] === 192 && parts[1] === 168) && !(parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) && !(parts[0] === 198 && [18, 19].includes(parts[1]));
}
/** Fixed origin, validated DNS pinned to this request, no redirects, bounded body/time. */
export const fetchOAuthMetadata: OAuthMetadataLoader = async value => {
  const url = new URL(chatGPTClientId(value));
  const deadline = Date.now() + 5000;
  const records = await Promise.race([lookup(url.hostname, { all: true }), new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new ApiError(502, 'ChatGPT metadata lookup timed out.')), 5000); timer.unref(); })]);
  if (!records.length || records.some(record => !publicAddress(record.address))) throw new ApiError(502, 'ChatGPT metadata could not be safely resolved.');
  const pinned = records.find(record => record.family === 4) ?? records[0];
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', family: pinned.family, headers: { Accept: 'application/json' }, lookup: (_host, options, callback) => { if (typeof options === 'object' && options.all) (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [pinned]); else callback(null, pinned.address, pinned.family); } }, response => {
      if (response.statusCode !== 200 || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers['content-type'] ?? '')) { response.destroy(); reject(new ApiError(502, 'ChatGPT metadata is unavailable.')); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 32768) req.destroy(new ApiError(502, 'ChatGPT metadata is too large.')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ApiError(502, 'ChatGPT metadata is invalid.')); } });
    });
    const timer = setTimeout(() => req.destroy(new ApiError(502, 'ChatGPT metadata lookup timed out.')), Math.max(1, deadline - Date.now()));
    timer.unref();
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject); req.end();
  });
};
export async function validateChatGPTClient(clientId: string, redirectUri: string, load: OAuthMetadataLoader = fetchOAuthMetadata) {
  chatGPTClientId(clientId);
  const metadata = z.object({ client_id: z.string(), redirect_uris: z.array(z.string().max(2048)).min(1).max(20), token_endpoint_auth_methods_supported: z.array(z.string()).max(10).optional(), token_endpoint_auth_method: z.string().optional(), grant_types: z.array(z.string()).max(10).optional(), response_types: z.array(z.string()).max(10).optional() }).parse(await load(clientId));
  const methods = metadata.token_endpoint_auth_methods_supported ?? [metadata.token_endpoint_auth_method];
  if (metadata.client_id !== clientId || !methods.includes('none') || !metadata.redirect_uris.includes(redirectUri) || metadata.grant_types && !metadata.grant_types.includes('authorization_code') || metadata.response_types && !metadata.response_types.includes('code')) throw new ApiError(400, 'The ChatGPT client or callback is not supported.');
  const redirect = new URL(redirectUri);
  if (redirect.origin !== 'https://chatgpt.com' || redirect.username || redirect.password || redirect.hash || redirect.search || redirect.pathname.length > 1024) throw new ApiError(400, 'The ChatGPT callback is invalid.');
  return { id: clientId, name: 'ChatGPT', redirectUri };
}
