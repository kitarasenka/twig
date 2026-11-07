import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';
import { validateRemoteTransport } from './remotes.js';

// A repository's own `.git` can name programs Git runs while it only *reads*:
// `git status` runs clean filters and, in a partial clone, a fetch; a fetch runs
// `core.sshCommand`, credential helpers, `remote.*.uploadpack` and hooks; a
// signature check runs `gpg.program`. 🌱 Twig reads on its own (status on open
// and on every refresh, background fetch, signatures), so a folder whose `.git`
// came from someone else — an archive, a shared drive — would run their program
// before the person did anything. Some settings run nothing and still decide
// what a push does (`remote.*.pushurl`), and the person sees those as well.
//
// So nothing is trusted by default: a setting that is not listed here as inert
// is shown. Hooks are shown too: the person's own commit or merge runs them, as
// in a terminal, but a folder they did not make has them from someone else.

// What Git writes itself and what people set every day, and sections that only
// other tools read. A subsection in a key never matters here unless named.
const SAFE = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|safecrlf|eol|quotepath|trustctime|checkstat|untrackedcache|splitindex|preloadindex|fscache|longpaths|compression|loosecompression|abbrev|commentchar|commentstring|whitespace|sparsecheckout|sparsecheckoutcone|protecthfs|protectntfs|hidedotfiles|editor|commitgraph|multipackindex|sharedrepository|warnambiguousrefs|bigfilethreshold|packedgitlimit|packedgitwindowsize|deltabasecachelimit|fsync|fsyncmethod)$/,
  /^(user|author|committer)\.[^.]+$/,
  /^init\.defaultbranch$/,
  /^extensions\.(objectformat|refstorage|worktreeconfig|noop|preciousobjects|relativeworktrees)$/,
  /^remote\..+\.(?!pushurl$|proxy$|proxyauthmethod$|push$|mirror$|receivepack$|uploadpack$|vcs$|promisor$|partialclonefilter$|serveroption$)[^.]+$/,
  /^branch\..+\.(?!pushremote$|mergeoptions$)[^.]+$/,
  /^branch\.(autosetupmerge|autosetuprebase|sort)$/,
  /^submodule\..+\.(url|active|branch|update|ignore|fetchrecursesubmodules|shallow)$/,
  /^submodule\.(active|recurse|fetchjobs|alternateerrorstrategy)$/,
  /^pull\.(rebase|ff)$/,
  /^push\.(autosetupremote|followtags|gpgsign|recursesubmodules|usebitmaps|negotiate)$/,
  /^fetch\.(prune|prunetags|parallel|writecommitgraph|fsckobjects|recursesubmodules|showforcedupdates|unpacklimit|negotiationalgorithm)$/,
  /^rebase\.(autostash|autosquash|updaterefs|abbreviatecommands|stat|missingcommitscheck|instructionformat|forkpoint|rebasemerges|rerereautoupdate)$/,
  /^merge\.(ff|conflictstyle|stat|log|renames|renamelimit|verifysignatures|autostash|directoryrenames|branchdesc)$/,
  /^diff\.(algorithm|renames|renamelimit|mnemonicprefix|noprefix|context|interhunkcontext|indentheuristic|colormoved|colormovedws|wserrorhighlight|submodule|ignoresubmodules|statgraphwidth|dirstat|relative|srcprefix|dstprefix)$/,
  /^diff\..+\.(xfuncname|funcname|binary|wordregex|cachetextconv)$/,
  /^filter\..+\.required$/,
  /^(log|format|color|column|status|blame|advice|i18n|help|rerere|gc|pack|repack|index|feature|sparse|checkout|clone|grep|am|apply|versionsort|mailmap|tag|stash)\.[^.]+$/,
  /^color\..+$/,
  /^(gc|maintenance)\..+\.(enabled|reflogexpire|reflogexpireunreachable|auto|schedule)$/,
  /^maintenance\.(auto|strategy)$/,
  /^commit\.(gpgsign|verbose|cleanup|status)$/,
  /^gpg\.(format|mintrustlevel)$/,
  /^gpg\.ssh\.(allowedsignersfile|revocationfile)$/,
  /^credential\.((.+\.)?(username|usehttppath)|interactive|guitimeout)$/,
  /^http\.(postbuffer|version|lowspeedlimit|lowspeedtime|maxrequests|minsessions)$/,
  /^lfs\.(url|repositoryformatversion|locksverify|fetchinclude|fetchexclude|allowincompletepush|concurrenttransfers|activitytimeout)$/,
  /^lfs\..+\.(access|locksverify)$/,
  /^alias\.[^.]+$/,
  /^(gitflow|gitlens|gk|svn|svn-remote|tig|magit|github|gitlab|hub|gh|git-town|gerrit|review|bitbucket|vscode)\./
];

// A finding here means a fetch would run it: the background fetch stays off for such a repository.
const FETCH_RISK = /^(core\.(sshcommand|gitproxy)|remote\..+\.(uploadpack|vcs|url)|credential\.|url\.|protocol\.|http\.|ssh\.)/;

// Signing programs people really configure. A bare name is looked up in PATH
// (never in the repository: see main/process-env.js); an absolute path must
// point outside the repository, or a planted `./tools/gpg` would pass.
const SIGNERS = new Set(['gpg', 'gpg2', 'gpgsm', 'ssh-keygen', 'op-ssh-sign']);
// Credential helpers that ship with Git or with the common installers, named
// the way Git resolves them (`git-credential-<name>` in PATH).
const HELPERS = new Set(['osxkeychain', 'manager', 'manager-core', 'store', 'cache', 'libsecret', 'gnome-keyring', 'wincred', 'oauth']);
// `ssh` with a key, a port or a harmless -o. Anything else still asks: -F reads
// a file that can hold ProxyCommand, -A hands the agent to the server.
const SAFE_SSH_OPTIONS = /^(IdentitiesOnly|IdentityFile|IdentityAgent|StrictHostKeyChecking|UserKnownHostsFile|Port|User|AddKeysToAgent|UseKeychain|ServerAliveInterval|ConnectTimeout|BatchMode)=[^\s;&|`$<>()]+$/i;
// What `git lfs install` writes, whole: a prefix would let `git-lfs clean; cmd` pass.
const LFS_FILTERS = {
  'filter.lfs.clean': ['git-lfs clean -- %f'],
  'filter.lfs.smudge': ['git-lfs smudge -- %f', 'git-lfs smudge --skip -- %f'],
  'filter.lfs.process': ['git-lfs filter-process', 'git-lfs filter-process --skip']
};
const PUSH_DEFAULTS = new Set(['simple', 'upstream', 'tracking', 'current', 'nothing']);

const NESTED_LIMIT = 64;
const HOOK_LIMIT = 64;
const HOOK_BYTES = 1024 * 1024;

// `roots`: the repository as Git prints it and as the person picked it — on
// macOS one is `/private/var/…` and the other `/var/…` for the same folder.
function insideRepository(file, roots, from = null) {
  return roots.some(root => {
    const relative = path.relative(root, path.resolve(from ?? root, file));
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

function safeSshCommand(value) {
  const words = value.trim().split(/\s+/);
  if (words.shift() !== 'ssh') return false;
  while (words.length) {
    const word = words.shift();
    if (['-i', '-p', '-l'].includes(word)) {
      const argument = words.shift();
      if (!argument || /[;&|`$<>()]/.test(argument)) return false;
    } else if (word === '-o') {
      if (!SAFE_SSH_OPTIONS.test(words.shift() || '')) return false;
    } else if (!/^-[46CTqvx]+$/.test(word)) return false;
  }
  return true;
}

/** Values that only name Git's own machinery or a well-known tool — not a program someone planted. `key` is in lower case. */
function harmless(key, value, { roots, configDir }) {
  const text = value.trim();
  if (key === 'core.fsmonitor') return /^(true|false|yes|no|on|off|1|0|)$/i.test(text);
  if (Object.hasOwn(LFS_FILTERS, key)) return LFS_FILTERS[key].includes(text);
  if (/^gpg\.(.+\.)?program$/.test(key)) {
    if (!SIGNERS.has(path.basename(text))) return false;
    return !text.includes('/') || (path.isAbsolute(text) && !insideRepository(text, roots));
  }
  if (/^credential\.(.+\.)?helper$/.test(key)) return text === '' || HELPERS.has(text);
  if (key === 'core.sshcommand') return safeSshCommand(text);
  if (key === 'push.default') return PUSH_DEFAULTS.has(text);
  // Empty is "no hooks folder set"; whatever the effective folder holds is listed on its own.
  if (key === 'core.hookspath') return text === '';
  // A submodule's or linked checkout's own Git directory points at its folder; elsewhere it moves the working tree.
  if (key === 'core.worktree') return insideRepository(text, roots, configDir);
  return false;
}

/** True for a setting that is not on the list of inert ones. The value can still clear it. */
export const isRiskyConfigKey = key => !SAFE.some(pattern => pattern.test(key.toLowerCase()));

function risky(key, value, context) {
  const lower = key.toLowerCase();
  if (/^remote\..+\.url$/.test(lower)) {
    try { validateRemoteTransport(value); return false; } catch { return true; }
  }
  if (/^submodule\..+\.update$/.test(lower)) return value.trim().startsWith('!');
  return isRiskyConfigKey(lower) && !harmless(lower, value, context);
}

/** `git config --null --list --show-scope --show-origin`: scope, origin, then `key\nvalue` or a bare `key`. */
function parseConfigList(output) {
  const records = output.split('\0');
  records.pop();
  const entries = [];
  for (let index = 0; index + 2 < records.length; index += 3) {
    const [scope, origin, item] = records.slice(index, index + 3);
    const split = item.indexOf('\n');
    entries.push({ scope, origin, key: split < 0 ? item : item.slice(0, split), value: split < 0 ? '' : item.slice(split + 1) });
  }
  return entries;
}

// Every value of the config passes through here, tokens in URLs and headers
// included, so the journal gets a count and never the text.
function quietLog(log, what) {
  return {
    start: entry => log.start(entry),
    output: async () => {},
    finish: async (id, result) => {
      const stdout = result.code === 0 ? `${what}, not shown.\n` : '';
      if (stdout) await log.output(id, 'stdout', stdout);
      await log.finish(id, { ...result, stdout, stderr: result.code === 0 ? '' : 'Git could not read these settings.\n' });
    }
  };
}

async function readConfig({ cwd, log, argv = [] }) {
  const result = await runGit({ argv: ['config', '--null', '--list', '--show-scope', '--show-origin', ...argv], cwd, ungated: true,
    log: quietLog(log, 'Settings read'), operation: 'Read repository config' });
  return result.code === 0 ? parseConfigList(result.stdout) : null;
}

const originFile = (origin, cwd) => (origin.startsWith('file:') ? path.resolve(cwd, origin.slice(5)) : null);

async function small(file, limit = 4096) {
  try {
    const info = await lstat(file);
    return info.isFile() && info.size <= limit ? await readFile(file, 'utf8') : null;
  } catch { return null; }
}

const realOr = target => realpath(target).catch(() => path.resolve(target));

/** The Git directory a `.git` entry stands for: the directory, or where a `.git` file leads. */
async function gitDirectoryOf(dot) {
  const info = await stat(dot).catch(() => null);
  if (info?.isDirectory()) return dot;
  const pointer = (await small(dot))?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  return pointer ? path.resolve(path.dirname(dot), pointer) : null;
}

/** Linked worktrees of the repository at `common`, as Git recorded them: its own folder, and the checkout each one belongs to. */
export async function linkedWorktrees(common) {
  const folder = path.join(common, 'worktrees');
  const names = await readdir(folder).catch(() => []);
  const links = [];
  for (const name of names) {
    const admin = path.join(folder, name);
    const back = (await small(path.join(admin, 'gitdir')))?.trim();
    if (back) links.push({ admin, checkout: path.dirname(path.resolve(admin, back)) });
  }
  return links;
}

/** True if the `.git` file in `checkout` leads to `admin`. Read without Git, so a forged one is never followed. */
export async function gitFileLeadsTo(checkout, admin) {
  const pointer = (await small(path.join(checkout, '.git')))?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  if (!pointer) return false;
  return await realOr(path.resolve(checkout, pointer)) === await realOr(admin);
}

/** Git directories under `<common>/modules`, at any depth (a submodule's name may hold `/`, and it may have its own). */
async function absorbedModules(folder, found = [], depth = 0) {
  if (depth > 8 || found.length >= NESTED_LIMIT) return found;
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const child = path.join(folder, entry.name);
    if (await lstat(path.join(child, 'HEAD')).catch(() => null)) {
      found.push(child);
      await absorbedModules(path.join(child, 'modules'), found, depth + 1);
    } else await absorbedModules(child, found, depth + 1);
  }
  return found;
}

/** The Git directory of every populated submodule: `git status` goes into each and uses its config. */
async function nestedRepositories({ root, common, cwd, log }) {
  const found = await absorbedModules(path.join(common, 'modules'));
  const result = await runGit({ argv: ['ls-files', '--stage', '-z'], cwd, ungated: true, log: quietLog(log, 'Index entries read'), operation: 'Read submodule entries' });
  const gitlinks = result.code === 0 ? result.stdout.split('\0').filter(line => line.startsWith('160000 ')).map(line => line.slice(line.indexOf('\t') + 1)) : [];
  for (const entry of gitlinks) {
    const target = await gitDirectoryOf(path.join(root, entry, '.git'));
    if (target) found.push(target);
  }
  const known = new Map();
  for (const folder of found) known.set(await realOr(folder), folder);
  return { folders: [...known.values()], complete: known.size < NESTED_LIMIT && result.code === 0 };
}

// What `git lfs install` writes into a repository that uses LFS: not worth a question.
const LFS_HOOK = /^#!\/bin\/sh\ncommand -v git-lfs >\/dev\/null 2>&1 \|\| \{ [^\n]*exit 2; \}\ngit lfs (pre-push|post-checkout|post-commit|post-merge) "\$@"\n$/;

/** The executable files in the hooks folder, with what identifies their content. */
async function readHooks(folder) {
  const hooks = [];
  for (const name of (await readdir(folder).catch(() => [])).sort()) {
    if (name.endsWith('.sample') || hooks.length >= HOOK_LIMIT) continue;
    const file = path.join(folder, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || (process.platform !== 'win32' && !(info.mode & 0o111))) continue;
    const bytes = info.size <= HOOK_BYTES ? await readFile(file).catch(() => null) : null;
    if (bytes && LFS_HOOK.test(bytes.toString('utf8'))) continue;
    const command = bytes?.toString('utf8').split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#')) ?? file;
    hooks.push({ name, command, content: bytes ? createHash('sha256').update(bytes).digest('hex') : String(info.size) });
  }
  return hooks;
}

/** The `exec` lines of a rebase in progress. 🌱 Twig's own plans have none: they come from a terminal, or from whoever wrote `.git`. */
export async function rebaseTodoCommands(gitDir) {
  const text = await small(path.join(gitDir, 'rebase-merge', 'git-rebase-todo'), 4 * 1024 * 1024);
  return (text ?? '').split('\n').map(line => line.trim()).filter(line => /^(x|exec)\s/.test(line));
}

const finding = (kind, key, value, detail = value) => ({
  kind, key, value, id: createHash('sha256').update(`${kind}\0${key}\0${detail}`).digest('hex').slice(0, 32)
});

async function stampOf(file, read = lstat) {
  try {
    const info = await read(file, { bigint: true });
    return `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`;
  } catch { return '-'; }
}

/**
 * What the files in `watch` look like on disk, as one string: no Git, a few
 * `lstat`s and one `readdir`. It is compared before every Git process, and Git
 * is asked about the settings again only when it changed. The change time is
 * in it, so writing a file and putting its modification time back still shows.
 * @param {{ files: string[], folders: string[], hooks: string, dot: string }} watch
 */
export async function readStamp(watch) {
  const parts = await Promise.all([...watch.files, ...watch.folders].map(file => stampOf(file)));
  // `.git` itself: its contents change on every commit, so a folder counts by identity alone.
  const dot = await lstat(watch.dot, { bigint: true }).catch(() => null);
  parts.push(dot?.isDirectory() ? `dir:${dot.ino}` : await stampOf(watch.dot));
  for (const name of (await readdir(watch.hooks).catch(() => [])).sort()) {
    if (!name.endsWith('.sample')) parts.push(`${name}:${await stampOf(path.join(watch.hooks, name), stat)}`);
  }
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

/**
 * Everything in a repository that runs a program or redirects a push, read
 * without running any of it. `findings` holds what the person has to see, each
 * with a stable `id`; `digest` is the whole set; `watch`/`stamp` tell later
 * whether it can have changed. `nested: false` leaves out submodules, for
 * callers that only ask about fetching. A folder outside any repository → null.
 * @returns {Promise<?{ root: string, gitDir: string, common: string, findings: Array<{ kind: string, key: string, value: string, id: string }>,
 *   partialClone: boolean, linked: Array<{ admin: string, checkout: string }>, digest: string, stamp: string,
 *   watch: { files: string[], folders: string[], hooks: string, dot: string } }>}
 */
export async function inspectRepository(directory, log, { nested = true } = {}) {
  const where = await runGit({ argv: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--git-path', 'hooks'],
    cwd: directory, log, operation: 'Verify repository', ungated: true });
  if (where.code !== 0) return null;
  const lines = where.stdout.split('\n');
  if (lines.length < 4) return null;
  const [root, gitDir] = lines;
  const common = await realOr(path.resolve(directory, lines[2]));
  const hooks = path.resolve(directory, lines[3]);
  const roots = [...new Set([root, path.resolve(directory), await realOr(root)])];
  const findings = [];
  const files = new Set([path.join(common, 'config'), path.join(common, 'config.worktree'), path.join(gitDir, 'config.worktree'),
    path.join(common, 'objects', 'info', 'alternates')]);
  const scan = (entries, configDir, prefix = '') => {
    for (const { key, value, origin } of entries) {
      const file = originFile(origin, directory);
      if (file) files.add(file);
      if (risky(key, value, { roots, configDir })) findings.push(finding('config', `${prefix}${key}`, value));
    }
  };

  const own = await readConfig({ cwd: directory, log });
  if (own === null) findings.push(finding('unreadable', 'config', 'Git could not read these settings.'));
  const local = (own ?? []).filter(entry => entry.scope === 'local' || entry.scope === 'worktree');
  scan(local, gitDir);
  const linked = await linkedWorktrees(common);
  for (const { admin, checkout } of linked) {
    const file = path.join(admin, 'config.worktree');
    files.add(file);
    if (await lstat(file).catch(() => null)) {
      scan(await readConfig({ cwd: directory, log, argv: ['--file', file, '--includes'] }) ?? [], admin, `${path.basename(checkout)}: `);
    }
  }
  if (nested) {
    const { folders, complete } = await nestedRepositories({ root, common, cwd: directory, log });
    for (const folder of folders.slice(0, NESTED_LIMIT)) {
      const prefix = `${path.relative(root, folder)}: `;
      for (const name of ['config', 'config.worktree']) {
        const file = path.join(folder, name);
        files.add(file);
        if (!await lstat(file).catch(() => null)) continue;
        scan(await readConfig({ cwd: directory, log, argv: ['--file', file, '--includes'] }) ?? [], folder, prefix);
      }
    }
    if (!complete) findings.push(finding('unreadable', 'submodules', 'Not all submodules could be checked.'));
  }

  for (const hook of await readHooks(hooks)) findings.push(finding('hook', `hooks/${hook.name}`, hook.command, hook.content));
  const alternates = await small(path.join(common, 'objects', 'info', 'alternates'), 65536);
  if (alternates?.trim()) findings.push(finding('alternates', 'objects/info/alternates', alternates.trim()));
  for (const command of await rebaseTodoCommands(gitDir)) findings.push(finding('todo', 'rebase-merge/git-rebase-todo', command));

  const unique = [...new Map(findings.map(item => [item.id, item])).values()];
  const watch = { files: [...files].sort(), folders: [path.join(common, 'worktrees'), path.join(common, 'modules')], hooks, dot: path.join(root, '.git') };
  return {
    root, gitDir, common, findings: unique, linked, watch, stamp: await readStamp(watch),
    partialClone: local.some(entry => /^(extensions\.partialclone|remote\..+\.promisor)$/.test(entry.key.toLowerCase())),
    digest: createHash('sha256').update(unique.map(item => item.id).sort().join('\0')).digest('hex')
  };
}

/**
 * What the person would have to see for this folder, as `{ key, value }`. Only
 * names and values Git prints are used: the key keeps its subsection's case,
 * because `[filter "Evil"]` and `[filter "evil"]` are two different filters.
 */
export async function findRiskyConfig(directory, log) {
  const inspection = await inspectRepository(directory, log);
  return inspection ? inspection.findings.map(({ key, value }) => ({ key, value })) : [];
}

/** One string for the settings and hooks of the repository at `cwd`: it changes when a program could have been added. */
export async function repoTrustDigest(cwd, log) {
  return (await inspectRepository(cwd, log))?.digest ?? 'no repository';
}

/** Settings that make a fetch run something, for the one fetch nobody asked for at that moment. */
export async function findFetchRisks(cwd, log) {
  const inspection = await inspectRepository(cwd, log, { nested: false });
  return (inspection?.findings ?? []).filter(item => item.kind === 'config' && FETCH_RISK.test(item.key.toLowerCase()));
}
