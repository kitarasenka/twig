import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = new URL('./', import.meta.url);
const output = new URL('dist/', source);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const formats = { dmg: 'dmg', nsis: 'exe', AppImage: 'AppImage', deb: 'deb' };
const platforms = { mac: 'macOS', win: 'Windows', linux: 'Linux' };
const downloads = [];
const cards = Object.entries(platforms).map(([platform, title]) => {
  const config = pkg.build[platform];
  const links = config.target.flatMap(({ target, arch }) => arch.map((architecture) => {
    const ext = formats[target];
    if (!ext) throw new Error(`Unsupported installer target: ${target}`);
    const filename = config.artifactName.replace(/\$\{(version|arch|ext)\}/g, (_, key) => ({ version: pkg.version, arch: architecture, ext })[key]);
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) throw new Error(`Unsafe or unresolved artifact name: ${filename}`);
    const href = `downloads/${filename}`;
    downloads.push({ platform, arch: architecture, format: ext, filename, href });
    const label = platform === 'mac' ? (architecture === 'arm64' ? 'Apple Silicon' : 'Intel') : (target === 'AppImage' ? 'AppImage · x64' : target === 'deb' ? 'Debian / Ubuntu · x64' : 'Установщик · x64');
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
await copyFile(new URL('renderer/src/ui/tokens.css', root), new URL('tokens.css', output));
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
console.log(`🌱 Twig ${pkg.version}: ${fileURLToPath(output)}\nUpload installers from release/ to site downloads/:\n${downloads.map(({ filename }) => filename).join('\n')}`);
