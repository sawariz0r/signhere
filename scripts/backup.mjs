import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const url = process.env.BACKUP_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set BACKUP_DATABASE_URL, MIGRATION_DATABASE_URL, or DATABASE_URL to the PostgreSQL database to back up.');
const output = resolve(process.argv[2] ?? `backups/signhere-${new Date().toISOString().replaceAll(':', '-')}.dump`);
if (existsSync(output)) throw new Error('Refusing to overwrite an existing backup.');
mkdirSync(dirname(output), { recursive: true });
const portable = resolve('.local/postgres/bin/pg_dump.exe');
const command = process.env.PG_DUMP ?? (existsSync(portable) ? portable : 'pg_dump');
// Credentials stay in the child's environment, never the command line or logs.
// pg_dump obtains a consistent PostgreSQL snapshot while the app remains online.
const connection = new URL(url);
if (!['postgres:', 'postgresql:'].includes(connection.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL.');
const connectionEnv = {
  PGHOST: connection.hostname.replace(/^\[|\]$/g, ''), PGPORT: connection.port || '5432',
  PGUSER: decodeURIComponent(connection.username), PGPASSWORD: decodeURIComponent(connection.password),
  PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
};
// libpq does not expand a connection URI supplied through PGDATABASE. Split it
// into environment settings, including TLS/options from the URL, without ever
// putting the password in process arguments.
const parameterEnv = {
  host: 'PGHOST', hostaddr: 'PGHOSTADDR', port: 'PGPORT', user: 'PGUSER', password: 'PGPASSWORD', dbname: 'PGDATABASE',
  sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', sslcrl: 'PGSSLCRL', sslcrldir: 'PGSSLCRLDIR',
  connect_timeout: 'PGCONNECT_TIMEOUT', options: 'PGOPTIONS', application_name: 'PGAPPNAME', target_session_attrs: 'PGTARGETSESSIONATTRS',
};
for (const [key, value] of connection.searchParams) {
  if (!(key in parameterEnv)) throw new Error('Unsupported DATABASE_URL connection option for backup: ' + key);
  connectionEnv[parameterEnv[key]] = value;
}
const child = spawn(command, ['--format=custom', '--no-owner', '--no-acl', '--file', output], {
  stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
  env: { ...process.env, ...connectionEnv },
});
child.on('error', error => { console.error(`Could not run pg_dump (${error.code}). Install a client matching the server or set PG_DUMP.`); process.exitCode = 1; });
child.on('exit', code => {
  if (code !== 0) { console.error('Backup failed; do not use a partial output file.'); process.exitCode = 1; }
  else console.log(`Consistent database backup written to ${output}. This is the database only: pair it with an encrypted backup of the sealing key volume and deployment settings. See docs/deployment.md. Store the pair off-host and test restoring it.`);
});
