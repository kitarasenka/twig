import { runGit } from './exec.js';

export const PROFILE_KEYS = Object.freeze(['user.name', 'user.email', 'core.editor', 'pull.rebase', 'init.defaultBranch',
  'commit.gpgSign', 'tag.gpgSign', 'gpg.format', 'user.signingKey', 'gpg.ssh.allowedSignersFile']);
// Git compares names in their canonical lower case; none of these holds a secret.
const PATTERN = '^(user[.](name|email|signingkey)|core[.]editor|pull[.]rebase|init[.]defaultbranch|commit[.]gpgsign|tag[.]gpgsign|gpg[.]format|gpg[.]ssh[.]allowedsignersfile)$';
/** Settings that take one of a few words; anything else is refused before Git sees it. */
export const PROFILE_CHOICES = Object.freeze({
  'pull.rebase': ['true', 'false', 'merges', 'interactive'],
  'commit.gpgSign': ['true', 'false'],
  'tag.gpgSign': ['true', 'false'],
  'gpg.format': ['openpgp', 'ssh', 'x509']
});

function validateScope(scope) {
  if (scope !== 'global' && scope !== 'local') throw new TypeError('Invalid configuration scope');
}

export function parseProfile(output) {
  const values = Object.fromEntries(PROFILE_KEYS.map(key => [key, null]));
  if (!output) return values;
  if (!output.endsWith('\0')) throw new Error('Incomplete Git configuration response');
  for (const record of output.slice(0, -1).split('\0')) {
    const split = record.indexOf('\n');
    const key = PROFILE_KEYS.find(item => item.toLowerCase() === record.slice(0, split).toLowerCase());
    if (split < 0 || !key) throw new Error('Unexpected Git configuration response');
    values[key] = record.slice(split + 1);
  }
  return values;
}

async function readValues({ cwd, log, env }, scope) {
  // Query only these non-secret keys: dumping all config would put credentials in the journal.
  const result = await runGit({ cwd, log, env, argv: ['config', ...(scope ? [`--${scope}`] : []), '--null', '--get-regexp', PATTERN] });
  if (result.code !== 0 && result.code !== 1) throw new Error('Could not read Git profile. Show output in the console.');
  return parseProfile(result.stdout);
}

export async function loadProfile(options) {
  validateScope(options.scope);
  const [values, effective] = await Promise.all([readValues(options, options.scope), readValues(options, null)]);
  return { scope: options.scope, values, effective };
}

export async function saveProfileValue(options) {
  const { cwd, log, env, scope, key, value, expected } = options;
  validateScope(scope);
  if (!PROFILE_KEYS.includes(key)) throw new TypeError('Unsupported Git profile field');
  if (expected !== null && (typeof expected !== 'string' || expected.length > 32768)) throw new TypeError('Invalid previous value');
  if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value))) {
    throw new TypeError('Enter a non-empty, single-line value or remove the setting.');
  }
  if (Object.hasOwn(PROFILE_CHOICES, key) && value !== null && !PROFILE_CHOICES[key].includes(value)) {
    throw new TypeError(key === 'pull.rebase' ? 'Choose a supported pull strategy.' : `Choose one of: ${PROFILE_CHOICES[key].join(', ')}.`);
  }
  if (key === 'init.defaultBranch' && value !== null) {
    if (value.startsWith('-') || value === 'HEAD') throw new TypeError('Invalid default branch name.');
    const checked = await runGit({ cwd, log, env, argv: ['check-ref-format', `refs/heads/${value}`] });
    if (checked.code !== 0) throw new TypeError('Invalid default branch name.');
  }
  const previous = await readValues(options, scope);
  if (previous[key] !== expected) throw new Error('This setting changed outside 🌱 Twig. Reload the profile before saving.');
  if (previous[key] !== value) {
    const argv = ['config', `--${scope}`, value === null ? '--unset-all' : '--replace-all', '--', key];
    if (value !== null) argv.push(value);
    const result = await runGit({ cwd, log, env, argv, operation: `Update ${scope} Git profile: ${key}` });
    if (result.code !== 0) throw new Error('Git could not save this setting. Show output in the console.');
  }
  return loadProfile(options);
}
