import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// electron-builder notarizes and staples the .app, but leaves the .dmg around
// it unsigned and unnotarized. A downloaded (quarantined) disk image is
// assessed on its own when it is opened, so a bare DMG can still meet
// "cannot verify the developer" before the app inside is ever looked at.
// electron-builder.config.cjs turns on `dmg.sign` and runs this hook only when
// signing is configured; here each signed DMG goes to the notary service and
// gets its ticket stapled.

const ATTEMPTS = 3;

async function xcrun(args) {
  const { stdout } = await execFileAsync('xcrun', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function credentials() {
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = process.env;
  if (!key || !keyId || !issuer) {
    throw new Error('notarize-dmg: APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER are required');
  }
  return ['--key', key, '--key-id', keyId, '--issuer', issuer];
}

async function submit(dmg, auth) {
  let lastError;
  // The upload to Apple's bucket sometimes dies with a connect timeout; a
  // rejected submission is not retried — resubmitting cannot change it.
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const out = await xcrun(['notarytool', 'submit', dmg, ...auth, '--wait', '--output-format', 'json']);
      return JSON.parse(out);
    } catch (error) {
      lastError = error;
      const detail = String(error.stderr || error.stdout || error.message).trim().split('\n').slice(-3).join(' ');
      console.warn(`  • notarize-dmg: attempt ${attempt}/${ATTEMPTS} for ${dmg} failed: ${detail}`);
    }
  }
  throw lastError;
}

export default async function notarizeDmgs(buildResult) {
  if (process.platform !== 'darwin') return [];
  const dmgs = buildResult.artifactPaths.filter((file) => file.endsWith('.dmg'));
  if (dmgs.length === 0) return [];
  const auth = credentials();
  for (const dmg of dmgs) {
    console.log(`  • notarizing DMG  file=${dmg}`);
    const result = await submit(dmg, auth);
    if (result.status !== 'Accepted') {
      let log = '';
      try { log = await xcrun(['notarytool', 'log', result.id, ...auth]); } catch { /* the status is enough */ }
      throw new Error(`notarize-dmg: ${dmg} was ${result.status} (submission ${result.id})\n${log}`);
    }
    await xcrun(['stapler', 'staple', dmg]);
    await xcrun(['stapler', 'validate', dmg]);
    console.log(`  • DMG notarized and stapled  file=${dmg}`);
  }
  return [];
}
