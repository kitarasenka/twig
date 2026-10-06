// Node's fs/promises without Electron's asar layer. Inside Electron `node:fs`
// reads an .asar file as a folder, so a recursive rm of an app bundle walks
// into Contents/Resources/app.asar, cannot remove the archive itself and
// fails with ENOTEMPTY — leaving a bundle that holds nothing but app.asar.
// `original-fs` is the same module without that layer; plain Node (the checks)
// has no such module and no such layer.
import nodeFs from 'node:fs';
import { createRequire } from 'node:module';

function load() {
  if (!process.versions.electron) return nodeFs;
  try { return createRequire(import.meta.url)('original-fs'); } catch { return nodeFs; }
}

export const plainFs = load().promises;
