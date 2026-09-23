import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/server/assets', { recursive: true });
cpSync('server/assets', 'dist/server/assets', { recursive: true });
