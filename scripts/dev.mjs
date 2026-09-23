import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
for (const path of ['.env', '.local/postgres.env']) if (existsSync(path)) process.loadEnvFile(path);
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL for a running PostgreSQL database before starting development.');
const origin = process.env.DEV_BASE_URL ?? 'http://localhost:5173';
const children = [
  spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', 'server/index.ts'], { windowsHide: true, stdio: 'inherit', env: { ...process.env, BASE_URL: origin, PORT: '3000', NODE_ENV: 'development' } }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { windowsHide: true, stdio: 'inherit' }),
];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
};
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code ?? 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log(`Signhere development UI: ${origin}`);
