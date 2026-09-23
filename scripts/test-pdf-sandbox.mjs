import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, open } from 'node:fs/promises';

// Run inside the actual Linux image: tests the same executable and kernel
// restrictions used by upload preparation, assembly and seal validation.
if (process.platform !== 'linux' || !process.env.SIGNHERE_PDF_SANDBOX_LAUNCHER) throw new Error('Run this probe inside the Signhere Linux image.');
const job = await mkdtemp('/tmp/signhere-sandbox-probe-');
const sibling = await mkdtemp('/tmp/signhere-sandbox-other-');
const marker = randomBytes(32).toString('hex');
const startup = process.argv.includes('--startup');
const forbidden = startup ? sibling + '/private-key-probe' : '/keys/sandbox-probe-' + randomBytes(12).toString('hex');
const dataProbe = startup ? sibling + '/private-data-probe' : '/data/sandbox-probe-' + randomBytes(12).toString('hex');
const parent = process.pid;
let inherited;
function child(executable, args, env, descriptor) {
  return new Promise((resolveRun, reject) => {
    const processChild = spawn(process.env.SIGNHERE_PDF_SANDBOX_LAUNCHER, [job, executable, ...args], { env, stdio: ['ignore', 'pipe', 'pipe', descriptor], windowsHide: true });
    const timer = setTimeout(() => processChild.kill('SIGKILL'), 15000);
    let stdout = '', stderr = '';
    processChild.stdout.on('data', chunk => { stdout += chunk; });
    processChild.stderr.on('data', chunk => { stderr += chunk; });
    processChild.once('error', reject);
    processChild.once('close', code => { clearTimeout(timer); code === 0 ? resolveRun(stdout) : reject(new Error('Sandbox probe failed: ' + stderr)); });
  });
}
try {
  await writeFile(forbidden, marker, { mode: 0o600 });
  await writeFile(dataProbe, marker, { mode: 0o600 });
  inherited = await open(forbidden, 'r');
  const source = `
import errno, os, socket, ctypes, asyncio, resource, fcntl, platform
from pathlib import Path
job, sibling, forbidden = ${JSON.stringify(job)}, ${JSON.stringify(sibling)}, ${JSON.stringify(forbidden)}
def blocked(action):
    try:
        action()
    except OSError as error:
        assert error.errno in (errno.EPERM, errno.EACCES, errno.EBADF), str(error)
    else:
        raise AssertionError('Forbidden operation succeeded')
# A pre-opened secret descriptor must not survive the launcher.
blocked(lambda: os.read(3, 64))
blocked(lambda: Path(forbidden).read_bytes())
blocked(lambda: os.chmod(forbidden, 0o600))
blocked(lambda: os.chown(forbidden, os.getuid(), os.getgid()))
blocked(lambda: os.utime(forbidden, None))
blocked(lambda: os.setxattr(forbidden, b'user.signhere_probe', b'test'))
blocked(lambda: resource.prlimit(${parent}, resource.RLIMIT_NOFILE))
blocked(lambda: fcntl.fcntl(0, fcntl.F_SETOWN, ${parent}))
blocked(lambda: fcntl.fcntl(0, fcntl.F_SETSIG, 0))
blocked(lambda: fcntl.fcntl(0, fcntl.F_SETFL, os.O_ASYNC))
blocked(lambda: Path(${JSON.stringify(dataProbe)}).read_bytes())
blocked(lambda: list(Path('/keys').iterdir()))
blocked(lambda: Path('/proc/${parent}/environ').read_bytes())
blocked(lambda: Path(sibling, 'leak').write_text('leak'))
blocked(lambda: Path('/tmp/worker-escaped-${parent}').write_text('leak'))
blocked(lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM))
blocked(lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))
blocked(lambda: os.fork())
Path(job, 'escape-link').symlink_to(forbidden)
blocked(lambda: Path(job, 'escape-link').read_bytes())
blocked(lambda: os.link(forbidden, Path(job, 'escape-hardlink')))
libc = ctypes.CDLL(None, use_errno=True)
assert libc.ptrace(16, ${parent}, 0, 0) == -1 and ctypes.get_errno() == errno.EPERM
queued_signal_calls = (129, 297) if platform.machine() == 'x86_64' else (138, 240)
for number in (*queued_signal_calls, 424, 452, 463, 466):
    # Signal zero / null arguments are harmless even if a filter regresses.
    ctypes.set_errno(0)
    assert libc.syscall(number, ${parent}, 0, 0, 0, 0, 0) == -1 and ctypes.get_errno() == errno.EPERM
assert 'DATABASE_URL' not in os.environ and 'SIGNHERE_SANDBOX_TEST_SECRET' not in os.environ
Path(job, 'allowed-result').write_text('bounded output')
assert Path(job, 'allowed-result').read_text() == 'bounded output'
async def event_loop_probe():
    await asyncio.sleep(0)
asyncio.run(event_loop_probe())
print('Python filesystem, network, process, descriptor, and environment boundaries passed.')
`;
  const result = await child(process.env.SIGNHERE_SEAL_PYTHON, ['-c', source], { ...process.env, SIGNHERE_SANDBOX_TEST_SECRET: marker }, inherited.fd);
  assert.match(result, /boundaries passed/);
  const nodeResult = await child(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', `
    import fs from 'node:fs'; import net from 'node:net';
    try { fs.readFileSync(${JSON.stringify(forbidden)}); throw Error('Read key succeeded'); } catch(error) { if(error.code !== 'EACCES' && error.code !== 'EPERM') throw error; }
    fs.writeFileSync(${JSON.stringify(job + '/node-result')}, 'ok');
    const server = net.createServer(); server.on('error', error => { if(error.code !== 'EPERM' && error.code !== 'EACCES') throw error; console.log('Node parser runtime and network boundary passed.'); }); server.listen(0, '127.0.0.1');
  `], process.env, inherited.fd);
  assert.match(nodeResult, /boundary passed/);
  console.log('Linux parser sandbox denies key/data reads, parent environment/ptrace, inherited secret descriptors, sockets, subprocesses, symlink/hardlink escape, and writes outside its job. Python and Node runtimes start successfully.');
} finally {
  await inherited?.close();
  await rm(forbidden, { force: true });
  await rm(dataProbe, { force: true });
  await rm(job, { recursive: true, force: true });
  await rm(sibling, { recursive: true, force: true });
}
