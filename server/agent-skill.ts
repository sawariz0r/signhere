import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { zipSync } from 'fflate';

const assetDirectory = new URL('./assets/skills/signhere/', import.meta.url);
const packageFiles = ['SKILL.md', 'references/draft-format.md', 'CHANGELOG.md'] as const;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Static package bytes are independent of request headers and of the instance hostname. */
export function buildAgentSkillPackage() {
  const metadata = JSON.parse(readFileSync(new URL('manifest.json', assetDirectory), 'utf8')) as {
    name: string; version: string; compatibleApiVersions: string[];
    skillUrl: string; packageUrl: string; changelogUrl: string;
  };
  const files = packageFiles.map(path => ({ path, bytes: readFileSync(new URL(path, assetDirectory)) }));
  const archive = Buffer.from(zipSync(Object.fromEntries(files.map(({ path, bytes }) => [
    // ZIP timestamps use local calendar fields: a local constructor keeps the bytes
    // identical across time zones and never crosses into ZIP's unsupported 1979.
    'signhere/' + path, [bytes, { mtime: new Date(1980, 0, 1) }],
  ])), { level: 6 }));
  const manifest = {
    ...metadata,
    packageSha256: sha256(archive),
    files: Object.fromEntries(files.map(({ path, bytes }) => [path, { sha256: sha256(bytes), bytes: bytes.length }])),
  };
  return { files, archive, manifest };
}

/** Mount at /skills/signhere, ahead of any SPA fallback. No credential is needed. */
export function createAgentSkillRouter() {
  const router = Router();
  const { files, archive, manifest } = buildAgentSkillPackage();
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
  });
  router.get('/manifest.json', (_req, res) => { res.json(manifest); });
  router.get('/signhere.zip', (_req, res) => {
    res.set('Content-Disposition', 'attachment; filename="signhere.zip"').type('application/zip').send(archive);
  });
  for (const { path, bytes } of files) {
    router.get('/' + path, (_req, res) => { res.type('text/markdown; charset=utf-8').send(bytes); });
  }
  // Unknown paths must not become an HTML application page or expose adjacent assets.
  router.use((_req, res) => { res.status(404).json({ error: 'Skill file not found.' }); });
  return router;
}
