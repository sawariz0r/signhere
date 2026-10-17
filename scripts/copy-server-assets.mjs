import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('dist/server/assets', { recursive: true });
cpSync('server/assets', 'dist/server/assets', { recursive: true });
// The runtime image has no package.json; the instance settings show this version.
writeFileSync('dist/server/assets/version.json', JSON.stringify({ version: JSON.parse(readFileSync('package.json', 'utf8')).version }) + '\n');
