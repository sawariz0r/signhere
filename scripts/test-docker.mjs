import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Destructive lifecycle/restore checks run only against generated disposable CI projects.
if (process.env.CI !== 'true' || process.env.SIGNHERE_RUN_DOCKER_TESTS !== '1') {
  throw new Error('This test requires CI=true and SIGNHERE_RUN_DOCKER_TESTS=1 on a disposable Docker runner.');
}
const root = resolve(import.meta.dirname, '..');
const suffix = randomBytes(8).toString('hex');
const output = resolve(root, '.test-artifacts', 'docker-' + suffix);
await mkdir(output, { recursive: true, mode: 0o700 });
const passwords = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
const projects = [];
const owner = { name: 'Container Test Owner', email: 'owner@example.test', password: randomBytes(32).toString('hex'), teamName: 'Disposable container test' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const redact = text => passwords.reduce((value, password) => value.replaceAll(password, '[redacted]'), String(text));
function docker(args, input) {
  return new Promise((resolveRun, reject) => {
    const child = execFile('docker', args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 600000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Docker command failed (${error.code}): ${redact(stderr || stdout)}`));
      else resolveRun(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function newProject(label) {
  const socket = createServer();
  await new Promise(resolveListen => socket.listen(0, '127.0.0.1', resolveListen));
  const port = socket.address().port;
  await new Promise(resolveClose => socket.close(resolveClose));
  const envPath = resolve(output, label + '.env');
  const origin = `http://127.0.0.1:${port}`;
  await writeFile(envPath, `POSTGRES_PASSWORD=${passwords[0]}\nAPP_DATABASE_PASSWORD=${passwords[1]}\nBASE_URL=${origin}\nPORT=${port}\nBIND_ADDRESS=127.0.0.1\n`, { mode: 0o600 });
  const project = { name: `signhere-ci-${suffix}-${label}`, origin, cookie: '' };
  project.run = (args, input) => docker(['compose', '--project-name', project.name, '--env-file', envPath, '--file', resolve(root, 'docker-compose.yaml'), ...args], input);
  projects.push(project);
  return project;
}
async function api(project, path, body, authenticated = true) {
  const response = await fetch(project.origin + path, {
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: project.origin }), ...(authenticated && project.cookie ? { Cookie: project.cookie } : {}) },
    method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie && authenticated) project.cookie = cookie.split(';')[0];
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
async function identity(project) {
  const ready = await fetch(project.origin + '/api/ready');
  assert.equal(ready.status, 200, 'Fresh/restored instance must be ready to seal.');
  const result = await api(project, '/.well-known/signhere-sealing.json');
  assert.equal(result.ready, true);
  assert.match(result.fingerprintSha256, /^[a-f0-9]{64}$/i);
  assert.match(result.certificatePem, /BEGIN CERTIFICATE/);
  return result;
}
async function completedDocument(project, documentId) {
  const deadline = Date.now() + 60000;
  do {
    const result = await api(project, '/api/documents/' + documentId);
    if (result.document.status === 'completed') return result.document;
    assert.equal(result.document.status, 'finalizing', 'Accepted approvals must be retained during sealing.');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  } while (Date.now() < deadline);
  throw new Error('Sealing did not finish within the Docker test deadline.');
}
async function signFixture(project, title) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([595, 842]).drawText('Disposable Docker integrity test - not an agreement', { font, x: 45, y: 780, size: 13 });
  const original = Buffer.from(await pdf.save());
  const created = await api(project, '/api/documents', { title, fileName: 'container-test.pdf', pdfBase64: original.toString('base64'), methodId: 'draw', recipients: [{ name: 'Container Test Client', email: 'client@example.test' }], includeSender: true });
  assert.equal(created.document.recipients.length, 2);
  for (const link of created.links) {
    const token = new URL(link.url).hash.slice(1);
    const session = await api(project, '/api/sign/session', { token }, false);
    const recipient = created.document.recipients.find(item => item.id === link.recipientId);
    assert.ok(recipient);
    const result = await api(project, '/api/sign/complete', {
      token, documentHash: created.document.originalHash, signingIntentHash: session.signingIntentHash,
      consentVersion: session.consent.version, accepted: true, name: recipient.name,
      payload: { strokes: [[[0.1, 0.2], [0.3, 0.8], [0.7, 0.2], [0.9, 0.6]]] },
    }, false);
    assert.ok(['pending', 'finalizing', 'completed'].includes(result.document.status));
  }
  const document = await completedDocument(project, created.document.id);
  assert.equal(document.recipients.filter(item => item.signedAt).length, 2);
  const response = await fetch(project.origin + '/api/documents/' + document.id + '/pdf?version=completed', { headers: { Cookie: project.cookie } });
  assert.equal(response.status, 200);
  const completed = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(completed), document.completedHash);
  return { id: document.id, hash: document.completedHash };
}
async function checkRuntimePermissions(project) {
  const result = await project.run(['exec', '-T', 'signhere', 'node', '--input-type=module', '-e', `
    import pg from 'pg'; import { statSync } from 'node:fs';
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const { rows } = await pool.query('SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user');
    if (rows[0].name !== 'signhere' || rows[0].rolsuper || rows[0].rolcreatedb || rows[0].rolcreaterole) throw Error('Runtime database role is privileged');
    for (const sql of ['CREATE TABLE public.ci_forbidden(id integer)', 'ALTER TABLE public.documents DISABLE TRIGGER ALL']) {
      let rejected = false; try { await pool.query(sql); } catch (error) { if (error.code === '42501') rejected = true; else throw error; }
      if (!rejected) throw Error('Runtime DDL was permitted');
    }
    const keys = statSync('/keys'); if ((keys.mode & 0o777) !== 0o700 || keys.uid !== process.getuid()) throw Error('Key directory permissions are unsafe');
    await pool.end(); console.log('Runtime role and key directory restrictions passed.');
  `]);
  assert.match(result, /restrictions passed/);
}
try {
  const source = await newProject('source');
  await source.run(['up', '--build', '-d', '--wait', '--wait-timeout', '180']);
  const firstIdentity = await identity(source);
  const setupToken = (await source.run(['exec', '-T', 'signhere', 'cat', '/data/setup-token'])).trim();
  await api(source, '/api/setup', { ...owner, setupToken });
  await checkRuntimePermissions(source);
  await source.run(['exec', '-T', 'signhere', 'node', 'scripts/test-pdf-sandbox.mjs']);
  const first = await signFixture(source, 'Before restart');
  await source.run(['down']); // Deliberately preserve named volumes.
  await source.run(['up', '-d', '--wait', '--wait-timeout', '180']);
  const restartedIdentity = await identity(source);
  assert.equal(restartedIdentity.installationId, firstIdentity.installationId);
  assert.equal(restartedIdentity.fingerprintSha256, firstIdentity.fingerprintSha256);
  assert.equal((await api(source, '/api/documents/' + first.id)).document.completedHash, first.hash);
  await signFixture(source, 'After restart');

  // No other actors/rotations exist in this isolated fixture. Stop the app after
  // exporting its key store, then snapshot the DB; both belong to this identity.
  const dumpPath = resolve(output, 'database.dump');
  const keysPath = resolve(output, 'keys.tar');
  await source.run(['exec', '-T', 'signhere', 'tar', '-C', '/keys', '-cf', '/tmp/ci-keys.tar', '.']);
  await source.run(['cp', 'signhere:/tmp/ci-keys.tar', keysPath]);
  await chmod(keysPath, 0o600);
  await source.run(['stop', 'signhere']);
  await source.run(['exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-d', 'signhere', '--format=custom', '--no-owner', '--no-acl', '--file=/tmp/ci-database.dump']);
  await source.run(['cp', 'postgres:/tmp/ci-database.dump', dumpPath]);
  await chmod(dumpPath, 0o600);
  const restored = await newProject('restored');
  await restored.run(['build', 'signhere']);
  await restored.run(['up', '-d', '--wait', '--wait-timeout', '90', 'postgres']);
  await restored.run(['cp', dumpPath, 'postgres:/tmp/ci-database.dump']);
  await restored.run(['exec', '-T', 'postgres', 'pg_restore', '-U', 'postgres', '-d', 'signhere', '--role=signhere_migrator', '--no-owner', '--no-acl', '--exit-on-error', '/tmp/ci-database.dump']);
  await restored.run(['run', '--rm', '-T', '--no-deps', '--entrypoint', 'node', 'signhere', '-e', 'if(require("node:fs").readdirSync("/keys").length) throw Error("Refusing nonempty restore target")']);
  await restored.run(['run', '--rm', '-T', '--no-deps', '--entrypoint', 'tar', 'signhere', '-C', '/keys', '-xf', '-'], await readFile(keysPath));
  await restored.run(['up', '-d', '--wait', '--wait-timeout', '180']);
  const restoredIdentity = await identity(restored);
  assert.equal(restoredIdentity.installationId, firstIdentity.installationId);
  assert.equal(restoredIdentity.fingerprintSha256, firstIdentity.fingerprintSha256);
  await api(restored, '/api/login', { email: owner.email, password: owner.password });
  assert.equal((await api(restored, '/api/documents/' + first.id)).document.completedHash, first.hash);
  await checkRuntimePermissions(restored);
  await signFixture(restored, 'After paired restore');
  console.log('Docker fresh setup, signing, restricted runtime role, restart, identity persistence, and paired key/database restore passed.');
} catch (error) {
  // Surface container output before teardown; compose only reports "unhealthy".
  for (const project of projects) {
    console.error(`--- ${project.name} logs ---`);
    console.error(await project.run(['logs', '--no-color', '--tail', '200']).catch(failure => redact(failure.message)).then(redact));
  }
  throw error;
} finally {
  for (const project of projects.reverse()) {
    // Names are generated above; never attach this test to an existing deployment.
    await project.run(['down', '--volumes', '--remove-orphans']).catch(error => console.error(redact(error.message)));
  }
  await rm(output, { recursive: true, force: true });
}
