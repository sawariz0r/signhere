import { spawn } from 'node:child_process';

// The production image fails before accepting requests if the host cannot
// enforce the parser boundary. This is a capability probe, not a security audit.
// It creates synthetic secrets only in isolated /tmp jobs; it never changes keys.
if (process.env.SIGNHERE_REQUIRE_PDF_SANDBOX === 'true') {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/test-pdf-sandbox.mjs', '--startup'], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Required PDF parser sandbox is unavailable. Check Linux Landlock/seccomp support; the application was not started.')));
  });
}
await import('../dist/server/index.js');
