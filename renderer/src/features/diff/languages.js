/**
 * Which grammar highlights a file, decided by its name alone — never by its
 * content, so a diff is classified before anything is read. Unknown names get
 * `null` and are shown as plain text, which is always correct if dull.
 *
 * The ids are Prism grammar names; `syntax.js` loads exactly these, and the
 * self-check keeps the two lists in step. No imports: Vite and the Node check
 * both load this file.
 */

/** Grammar id → the name shown above a diff. */
export const LANGUAGES = Object.freeze({
  javascript: 'JavaScript', jsx: 'JSX', typescript: 'TypeScript', tsx: 'TSX', json: 'JSON',
  css: 'CSS', scss: 'SCSS', less: 'Less', markup: 'HTML / XML', markdown: 'Markdown',
  python: 'Python', ruby: 'Ruby', php: 'PHP', go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin',
  scala: 'Scala', groovy: 'Groovy', swift: 'Swift', c: 'C', cpp: 'C++', csharp: 'C#', objectivec: 'Objective-C',
  dart: 'Dart', lua: 'Lua', perl: 'Perl', r: 'R', elixir: 'Elixir', haskell: 'Haskell',
  bash: 'Shell', powershell: 'PowerShell', batch: 'Batch', sql: 'SQL', graphql: 'GraphQL',
  yaml: 'YAML', toml: 'TOML', ini: 'INI', docker: 'Dockerfile', makefile: 'Makefile', hcl: 'HCL',
  protobuf: 'Protocol Buffers', nginx: 'nginx', diff: 'Diff', git: 'Git'
});

const BY_EXTENSION = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', lock: null,
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  html: 'markup', htm: 'markup', xhtml: 'markup', xml: 'markup', svg: 'markup', plist: 'markup', vue: 'markup',
  svelte: 'markup', xaml: 'markup', csproj: 'markup', rss: 'markup', atom: 'markup',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  py: 'python', pyi: 'python', pyw: 'python',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby', php: 'php', phtml: 'php',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', sc: 'scala',
  groovy: 'groovy', gradle: 'groovy', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hh: 'cpp', hpp: 'cpp', hxx: 'cpp', ino: 'cpp',
  cs: 'csharp', m: 'objectivec', mm: 'objectivec',
  dart: 'dart', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r', ex: 'elixir', exs: 'elixir', hs: 'haskell',
  sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash', fish: 'bash', ebuild: 'bash', eclass: 'bash',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', bat: 'batch', cmd: 'batch',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', editorconfig: 'ini',
  tf: 'hcl', tfvars: 'hcl', hcl: 'hcl', proto: 'protobuf', diff: 'diff', patch: 'diff'
};

/** Whole file names that say more than an extension would (or have none). */
const BY_NAME = {
  dockerfile: 'docker', containerfile: 'docker', makefile: 'makefile', gnumakefile: 'makefile',
  gemfile: 'ruby', rakefile: 'ruby', podfile: 'ruby', vagrantfile: 'ruby', brewfile: 'ruby',
  '.bashrc': 'bash', '.zshrc': 'bash', '.profile': 'bash', '.bash_profile': 'bash', '.envrc': 'bash',
  '.gitconfig': 'ini', '.gitmodules': 'ini', '.npmrc': 'ini', '.gitignore': 'git', '.gitattributes': 'git',
  '.dockerignore': 'git', 'nginx.conf': 'nginx', 'cmakelists.txt': null, 'package-lock.json': 'json'
};

/**
 * @param {string | null | undefined} path a repository path, `/`-separated
 * @returns {string | null} a key of LANGUAGES, or null for plain text
 */
export function languageFor(path) {
  if (typeof path !== 'string' || !path) return null;
  const name = path.split('/').at(-1).toLowerCase();
  if (Object.hasOwn(BY_NAME, name)) return BY_NAME[name];
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'docker';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = name.slice(dot + 1);
  return Object.hasOwn(BY_EXTENSION, extension) ? BY_EXTENSION[extension] : null;
}

/** The name shown above a diff: the language, or "Plain text". */
export function languageLabel(language) {
  return language && Object.hasOwn(LANGUAGES, language) ? LANGUAGES[language] : 'Plain text';
}
