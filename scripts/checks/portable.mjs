import assert from 'node:assert/strict';
import path from 'node:path';
import { resolvePortableDataDir, portableHostDir, PORTABLE_DIRNAME, PORTABLE_MARKER }
  from '../../main/portable.js';

const never = () => false;
const always = () => true;

// TWIG_DATA_DIR is honoured on any platform, packaged or not, and must be absolute.
assert.equal(
  resolvePortableDataDir({ env: { TWIG_DATA_DIR: '/srv/twig' }, platform: 'linux', packaged: false, execPath: '/x', exists: never }),
  '/srv/twig');
assert.throws(
  () => resolvePortableDataDir({ env: { TWIG_DATA_DIR: 'rel/twig' }, platform: 'linux', packaged: true, execPath: '/x', exists: never }),
  /absolute/);

// A dev / unpackaged run never goes portable on its own.
assert.equal(
  resolvePortableDataDir({ env: { TWIG_PORTABLE: '1' }, platform: 'darwin', packaged: false, execPath: '/a/Twig.app/Contents/MacOS/Twig', exists: always }),
  null);

// Windows portable launch: PORTABLE_EXECUTABLE_DIR is the anchor, no marker needed.
assert.equal(
  resolvePortableDataDir({ env: { PORTABLE_EXECUTABLE_DIR: 'D:\\stick' }, platform: 'win32', packaged: true, execPath: 'C:\\Temp\\app\\Twig.exe', exists: never }),
  path.join('D:\\stick', PORTABLE_DIRNAME));

// A plain Windows install (nsis) stays on the OS directory.
assert.equal(
  resolvePortableDataDir({ env: {}, platform: 'win32', packaged: true, execPath: 'C:\\Program Files\\Twig\\Twig.exe', exists: never }),
  null);

// Linux AppImage: state lands next to the .AppImage file only when opted in.
const appImage = { env: { APPIMAGE: '/media/usb/Twig-1.2.3.AppImage' }, platform: 'linux', packaged: true, execPath: '/tmp/.mount_x/twig', exists: never };
assert.equal(resolvePortableDataDir(appImage), null);
assert.equal(
  resolvePortableDataDir({ ...appImage, env: { ...appImage.env, TWIG_PORTABLE: 'true' } }),
  path.join('/media/usb', PORTABLE_DIRNAME));
assert.equal(
  resolvePortableDataDir({ ...appImage, exists: (p) => p === path.join('/media/usb', PORTABLE_MARKER) }),
  path.join('/media/usb', PORTABLE_DIRNAME));

// macOS: walk out of the .app bundle; opt in with a marker or an existing folder.
const macExec = '/Volumes/Twig/Twig.app/Contents/MacOS/Twig';
assert.equal(portableHostDir({ env: {}, platform: 'darwin', execPath: macExec }), '/Volumes/Twig');
assert.equal(
  resolvePortableDataDir({ env: {}, platform: 'darwin', packaged: true, execPath: macExec, exists: never }),
  null);
assert.equal(
  resolvePortableDataDir({ env: {}, platform: 'darwin', packaged: true, execPath: macExec, exists: (p) => p === path.join('/Volumes/Twig', PORTABLE_DIRNAME) }),
  path.join('/Volumes/Twig', PORTABLE_DIRNAME));

// A non-bundle executable path just uses its own directory.
assert.equal(portableHostDir({ env: {}, platform: 'darwin', execPath: '/opt/twig/bin/Twig' }), '/opt/twig/bin');
assert.equal(portableHostDir({ env: {}, platform: 'linux', execPath: undefined }), null);

console.log('portable check passed');
