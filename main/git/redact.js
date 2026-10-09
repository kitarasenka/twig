// Credentials inside URLs, cut out of anything 🌱 Twig keeps or shows: the
// command journal, failure reasons, answers to agents. No imports — the
// journal, Git helpers and Node checks all load it.
//
// `https://token@host`, `https://user:pass@host` (a password may even hold a
// `/`) become `https://***@host`. A bare SSH user (`ssh://git@host`) is not a
// secret and is left alone; `ssh://user:pass@host` is not.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]*)(:[^\s@]*)?@/gi;

export function redactCredentials(text) {
  if (typeof text !== 'string' || !text.includes('@')) return text;
  return text.replace(URL_USERINFO, (match, scheme, user, password) => {
    if (!password && !/^(https?|ftps?):\/\/$/i.test(scheme)) return match;
    if (!user && !password) return match;
    return `${scheme}***@`;
  });
}
