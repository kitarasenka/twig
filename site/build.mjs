import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = new URL('./', import.meta.url);
const output = new URL('dist/', source);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
// Where the download buttons point. Default: a sibling downloads/ directory next
// to the page (self-hosting). Set TWIG_SITE_DOWNLOAD_BASE to an absolute https
// prefix — e.g. a GitHub Releases URL — when the installers live off-site, which
// is how the GitHub Pages workflow builds the page.
const DEFAULT_DOWNLOAD_BASE = 'downloads/';
const rawBase = process.env.TWIG_SITE_DOWNLOAD_BASE?.trim() || DEFAULT_DOWNLOAD_BASE;
const downloadBase = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
if (downloadBase !== DEFAULT_DOWNLOAD_BASE && !/^https:\/\/[a-z0-9.-]+(?:\/[a-z0-9._~-]+)*\/$/i.test(downloadBase)) {
  throw new Error(`Unsafe site download base: ${downloadBase}`);
}
const formats = { dmg: 'dmg', nsis: 'exe', deb: 'deb', AppImage: 'AppImage' };
// electron-builder rewrites ${arch} per target: deb gets Debian names, AppImage
// the uname spelling. Raw x64 would produce dead links for both.
const archNames = { deb: { x64: 'amd64' }, AppImage: { x64: 'x86_64' } };
const platforms = { mac: 'macOS', win: 'Windows', linux: 'Linux' };
const downloads = [];
const cards = Object.entries(platforms).map(([platform, title]) => {
  const config = pkg.build[platform];
  const links = config.target.flatMap(({ target, arch }) => arch.map((architecture) => {
    const ext = formats[target];
    if (!ext) throw new Error(`Unsupported installer target: ${target}`);
    const template = config.artifactName;
    const archName = archNames[target]?.[architecture] || architecture;
    const filename = template.replace(/\$\{(version|arch|ext)\}/g, (_, key) => ({ version: pkg.version, arch: archName, ext })[key]);
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) throw new Error(`Unsafe or unresolved artifact name: ${filename}`);
    const href = `${downloadBase}${filename}`;
    downloads.push({ platform, arch: architecture, format: ext, filename, href });
    const macArch = architecture === 'arm64' ? 'Apple Silicon' : 'Intel';
    const label = platform === 'mac'
      ? macArch
      : target === 'deb' ? 'Debian / Ubuntu · x64'
      : target === 'AppImage' ? 'AppImage · x64'
      : 'Установщик · x64';
    return `<a class="download-link" href="${href}" download><span>${label}<small>.${ext}</small></span><span aria-hidden="true">↓</span></a>`;
  }));
  return `<article class="download-card"><span class="platform-label">DESKTOP / ${platform === 'mac' ? '01' : platform === 'win' ? '02' : '03'}</span><h3>${title}</h3>${links.join('')}</article>`;
}).join('\n');

await mkdir(new URL('assets/', output), { recursive: true });
const template = await readFile(new URL('index.html', source), 'utf8');
const html = template.replaceAll('{{version}}', escape(pkg.version)).replace('{{downloads}}', cards);
if (/\{\{\w+\}\}/.test(html)) throw new Error('Unresolved site template');
await writeFile(new URL('index.html', output), html);
await writeFile(new URL('downloads.json', output), JSON.stringify({ version: pkg.version, downloads }, null, 2) + '\n');
await copyFile(new URL('style.css', source), new URL('style.css', output));
await copyFile(new URL('site.js', source), new URL('site.js', output));
const tokens = await readFile(new URL('renderer/src/ui/tokens.css', root), 'utf8');
await writeFile(new URL('tokens.css', output), tokens.replaceAll(":root[data-theme='light']", "[data-theme='light']"));
await copyFile(new URL('assets/workspace.png', source), new URL('assets/workspace.png', output));
await copyFile(new URL('renderer/public/twig-logo.png', root), new URL('assets/twig-small.png', output));
await copyFile(new URL('assets/twig.png', source), new URL('assets/twig.png', output));
for (const weight of [400, 500, 600, 700]) {
  for (const subset of ['latin', 'cyrillic']) {
    const filename = `fira-sans-${subset}-${weight}-normal.woff2`;
    await copyFile(new URL(`node_modules/@fontsource/fira-sans/files/${filename}`, root), new URL(`assets/${filename}`, output));
  }
}
await copyFile(new URL('node_modules/@fontsource/fira-sans/LICENSE', root), new URL('assets/FONT-LICENSE.txt', output));
console.log(`🌱 Twig ${pkg.version}: ${fileURLToPath(output)}\nDownload links point at ${downloadBase}\nInstallers expected (from release/):\n${downloads.map(({ filename }) => filename).join('\n')}`);
