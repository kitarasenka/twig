// Environment fixes applied once, at the top of the main process, before any
// child is spawned. No imports — the Node check runs it with a fake env.
//
// 🌱 Twig runs `git` (and automation commands) by bare name with the working
// directory inside a repository someone else may have written:
// - Windows: CreateProcess-style lookup (libuv `search_path`) tries the working
//   directory before PATH, so a `git.exe` committed at a repository root would
//   run instead of Git. `NoDefaultCurrentDirectoryInExePath` turns that off
//   for this process and everything it starts.
// - Linux/macOS: an empty entry in `PATH` or `LD_LIBRARY_PATH` means "the
//   current directory". The AppImage runtime of older electron-builder exported
//   `LD_LIBRARY_PATH` with a trailing `:` (GHSA-7g7r-gx96-252g), which let a
//   `.so` in the repository load into git. Empty and relative entries go.
const SEARCH_PATHS = ['PATH', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH'];

export function hardenProcessEnv(env, platform) {
  if (platform === 'win32') {
    env.NoDefaultCurrentDirectoryInExePath = '1';
    return env;
  }
  for (const key of SEARCH_PATHS) {
    if (typeof env[key] !== 'string') continue;
    const kept = env[key].split(':').filter(entry => entry.startsWith('/'));
    if (kept.length) env[key] = kept.join(':');
    else delete env[key];
  }
  return env;
}
