import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electron from 'electron';

const productName = '🌱 Twig';
const iconName = 'twig';

function plutil(argv) {
  return spawnSync('plutil', argv, { shell: false, encoding: 'utf8' });
}

function readString(info, key) {
  const result = plutil(['-extract', key, 'raw', '-o', '-', info]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function plistIsSealed(bundle) {
  const result = spawnSync('codesign', ['-dv', '--verbose=2', bundle], { shell: false, encoding: 'utf8' });
  if (result.status !== 0) return false;
  return !/Info\.plist=not bound/.test(result.stderr);
}

export function brandDevelopmentApp() {
  if (process.platform !== 'darwin') return;
  const bundle = path.resolve(electron, '..', '..', '..');
  const info = path.join(bundle, 'Contents', 'Info.plist');
  const icon = path.join(bundle, 'Contents', 'Resources', `${iconName}.icns`);
  if (!existsSync(info) || path.extname(bundle) !== '.app') return;
  if (readString(info, 'CFBundleName') === productName && existsSync(icon)) return;
  if (plistIsSealed(bundle)) {
    console.warn(`Left the development bundle named ${readString(info, 'CFBundleName')}: its Info.plist is covered by the code signature.`);
    return;
  }
  const source = fileURLToPath(new URL('../build/icon.icns', import.meta.url));
  if (existsSync(source)) {
    copyFileSync(source, icon);
    plutil(['-replace', 'CFBundleIconFile', '-string', iconName, info]);
  }
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    const result = plutil(['-replace', key, '-string', productName, info]);
    if (result.status !== 0) { console.warn(`Could not rename the development bundle: ${result.stderr.trim()}`); return; }
  }
  const now = new Date();
  utimesSync(bundle, now, now);
}
