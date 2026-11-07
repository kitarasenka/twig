// Credentials cut out of anything 🌱 Twig keeps or shows: the command journal,
// automation output, failure reasons, answers to agents. No imports — the
// journal, Git helpers and Node checks all load it.
//
// `https://token@host`, `https://user:pass@host` (a password may hold a `/`
// or an `@`) become `https://***@host`. A bare SSH user (`ssh://git@host`) is
// not a secret and is left alone; `ssh://user:pass@host` is not. Lengths are
// bounded: this runs over all output, and a minified line can be megabytes.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:]{0,512})(:[^\s]{0,512})?@/gi;
// `user:token@github.com:org/repo.git`: the scp form with a password in it.
const SCP_USERINFO = /(^|[\s"'=(])[\w.-]{1,128}:[^\s/@:]{6,512}@(?=[\w-]+\.)/g;
const HEADER = /\b(authorization["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+|token\s+)?)[^\s"']{6,}/gi;
const BEARER = /\b(bearer\s+)[\w.~+/-]{16,}=*/gi;
const QUERY = /([?&](?:access_token|private_token|client_secret|token|api[_-]?key|password|passwd|secret)=)[^&\s"'#]+/gi;
// The same well-known shapes the "Scan for secrets" automation looks for.
const TOKEN = /\b(?:gh[posru]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z_]{40,}|glpat-[0-9A-Za-z_-]{20,}|(?:sk|rk)_live_[0-9A-Za-z]{20,}|sk-ant-[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|npm_[0-9A-Za-z]{36}|AIza[0-9A-Za-z_-]{35}|(?:AKIA|ASIA)[0-9A-Z]{16})/g;

export function redactCredentials(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(URL_USERINFO, (match, scheme, user, password) => {
      if (!password && !/^(https?|ftps?):\/\/$/i.test(scheme)) return match;
      if (!user && !password) return match;
      return `${scheme}***@`;
    })
    .replace(SCP_USERINFO, (match, before) => (/mailto:/i.test(match) ? match : `${before}***@`))
    .replace(HEADER, '$1***')
    .replace(BEARER, '$1***')
    .replace(QUERY, '$1***')
    .replace(TOKEN, '***');
}
