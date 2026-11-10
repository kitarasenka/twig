/**
 * The folder a clone suggests for an address: its last path segment without
 * `.git`, the way `git clone` itself names the folder. No imports — Vite and
 * the Node check both load it. Anything `validateCloneName` in main would
 * refuse comes back as '' and the field stays for the person to fill in.
 */
export function cloneFolderName(url) {
  if (typeof url !== 'string') return '';
  const rest = url.trim().replace(/[?#].*$/, '').replace(/[\\/]+$/, '').replace(/\.git$/i, '').replace(/[\\/]+$/, '');
  // Only a host (`https://host`, `ssh://git@host:22`, `git@host:`) names no repository.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*$/i.test(rest) || /^[^/:]+:?$/.test(rest)) return '';
  const name = rest.split(/[\\/:]/).pop() || '';
  if (!name || name.length > 180 || /[<>:"/\\|?*]/.test(name) || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || /^[. -]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)/i.test(name)) return '';
  return name;
}
