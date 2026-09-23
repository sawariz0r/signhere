import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const action = process.argv[2] ?? 'status';
if (!['start', 'stop', 'status'].includes(action)) throw new Error('Use start, stop, or status.');
const executable = resolve('.local/postgres/bin/pg_ctl.exe');
const data = resolve('.local/pgdata');
if (!existsSync(executable) || !existsSync(data + '/PG_VERSION')) throw new Error('Workspace-local PostgreSQL is not initialized. Use your own PostgreSQL server and set DATABASE_URL.');
const current = spawnSync(executable, ['-D', data, 'status'], { stdio: action === 'status' ? 'inherit' : 'ignore', windowsHide: true });
if (action === 'status') process.exitCode = current.status ?? 1;
else if (action === 'start' && current.status === 0) console.log('PostgreSQL is already running on 127.0.0.1:15432.');
else if (action === 'stop' && current.status !== 0) console.log('PostgreSQL is already stopped.');
else {
  const args = action === 'start'
    ? ['-D', data, '-l', resolve('.local/postgres.log'), '-w', '-t', '20', 'start']
    : ['-D', data, '-m', 'fast', '-w', '-t', '20', 'stop'];
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; console.log(code === 0 ? `PostgreSQL ${action} completed.` : 'PostgreSQL control failed. Inspect .local/postgres.log.'); });
}
