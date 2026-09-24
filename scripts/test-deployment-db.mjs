import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

// Uses a disposable database/roles only; the caller needs a test-only role with
// CREATEDB/CREATEROLE (or a test superuser). Never point this at a production server.
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL for disposable deployment-role tests.');
const connection = new URL(databaseUrl);
const fixture = 'deploy_' + randomBytes(12).toString('hex');
const migrator = fixture + '_m';
const passwords = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
const output = resolve('.test-artifacts', fixture);
await mkdir(output, { recursive: true, mode: 0o700 });
const source = await readFile('deploy/postgres/10-signhere-roles.sh', 'utf8');
let sql = source.split("<<'SQL'\n")[1]?.replace(/\nSQL\s*$/, '');
assert.ok(sql, 'Unable to extract bootstrap SQL');
// The real bootstrap intentionally disables its freshly initialized postgres
// password. This test must never alter the existing test-server administrator.
sql = sql.replace('ALTER ROLE postgres PASSWORD NULL;', '').replaceAll('signhere_migrator', migrator).replace(/\bsignhere\b/g, fixture);
assert.ok(!/ALTER ROLE postgres/.test(sql));
const sqlPath = resolve(output, 'roles.sql');
await writeFile(sqlPath, sql, { mode: 0o600 });
const portable = resolve('.local/postgres/bin/psql.exe');
const command = process.env.PSQL ?? (existsSync(portable) ? portable : 'psql');
const admin = new pg.Pool({ connectionString: databaseUrl });
let owner, runtime;
async function provision(samePassword = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, ['-X', '--set=ON_ERROR_STOP=1', '--file', sqlPath], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PGHOST: connection.hostname, PGPORT: connection.port || '5432', PGUSER: decodeURIComponent(connection.username), PGPASSWORD: decodeURIComponent(connection.password), PGDATABASE: fixture, POSTGRES_PASSWORD: passwords[0], APP_DATABASE_PASSWORD: samePassword ? passwords[0] : passwords[1] },
    });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveRun() : reject(new Error('Role bootstrap rejected: ' + passwords.reduce((message, password) => message.replaceAll(password, '[redacted]'), stderr))));
  });
}
function connectAs(user, password) {
  const url = new URL(databaseUrl); url.username = user; url.password = password; url.pathname = '/' + fixture;
  const pool = new pg.Pool({ connectionString: url.href });
  // pool.end() resolves before sockets close; DROP ... WITH (FORCE) then terminates them (57P01).
  pool.on('error', error => { if (error.code !== '57P01') console.error(error); });
  return pool;
}
try {
  await admin.query(`CREATE DATABASE "${fixture}"`);
  await assert.rejects(provision(true), /Role bootstrap rejected/);
  assert.equal((await admin.query('SELECT count(*) FROM pg_roles WHERE rolname=ANY($1)', [[fixture, migrator]])).rows[0].count, '0');
  await provision();
  owner = connectAs(migrator, passwords[0]); runtime = connectAs(fixture, passwords[1]);
  await owner.query('CREATE TABLE public.permission_probe(id serial PRIMARY KEY, value text NOT NULL)');
  await runtime.query("INSERT INTO public.permission_probe(value) VALUES('first')");
  await runtime.query("UPDATE public.permission_probe SET value='second'");
  assert.equal((await runtime.query('SELECT value FROM public.permission_probe')).rows[0].value, 'second');
  await runtime.query('DELETE FROM public.permission_probe');
  for (const query of ['CREATE TABLE public.forbidden(id integer)', 'ALTER TABLE public.permission_probe DISABLE TRIGGER ALL', 'TRUNCATE public.permission_probe']) {
    await assert.rejects(runtime.query(query), error => error.code === '42501');
  }
  const roles = (await admin.query('SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=ANY($1)', [[fixture, migrator]])).rows;
  assert.equal(roles.length, 2); assert.ok(roles.every(role => !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole));
  console.log('Fresh deployment SQL passed: distinct passwords, non-superuser migration owner, automatic DML/sequence grants, and runtime DDL/trigger/TRUNCATE denial.');
} finally {
  await owner?.end(); await runtime?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${fixture}" WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS "${fixture}"`);
  await admin.query(`DROP ROLE IF EXISTS "${migrator}"`);
  await admin.end();
  await rm(output, { recursive: true, force: true });
}
