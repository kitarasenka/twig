/**
 * Local credential patterns for the "Scan for secrets" action. The scan runs
 * entirely on the machine — it reads the added lines of the staged diff (main
 * supplies the text) and reports which rule matched where. It never returns the
 * matched value and never sends anything anywhere.
 *
 * Pure and import-free: loaded by Vite and by Node in
 * `scripts/checks/secret-rules.mjs`.
 */

export const SECRET_RULES = [
  { id: 'aws-access-key', label: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', label: 'GitHub token', pattern: /\bgh[posru]_[0-9A-Za-z]{36,}\b/ },
  { id: 'github-fine-grained-token', label: 'GitHub token', pattern: /\bgithub_pat_[0-9A-Za-z_]{40,}\b/ },
  { id: 'gitlab-token', label: 'GitLab token', pattern: /\bglpat-[0-9A-Za-z_-]{20,}\b/ },
  { id: 'stripe-key', label: 'Stripe secret key', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
  { id: 'anthropic-key', label: 'Anthropic API key', pattern: /\bsk-ant-[0-9A-Za-z_-]{20,}/ },
  { id: 'openai-key', label: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[0-9A-Za-z_-]{20,}T3BlbkFJ[0-9A-Za-z_-]{20,}/ },
  { id: 'slack-webhook', label: 'Slack webhook', pattern: /\bhttps:\/\/hooks\.slack\.com\/services\/T[0-9A-Z]+\/B[0-9A-Z]+\/[0-9A-Za-z]+/ },
  { id: 'telegram-bot-token', label: 'Telegram bot token', pattern: /\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/ },
  { id: 'npm-token', label: 'npm token', pattern: /\bnpm_[0-9A-Za-z]{36}\b/ },
  { id: 'url-password', label: 'Password in a URL', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@[^\s/]+/i },
  { id: 'slack-token', label: 'Slack token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { id: 'google-api-key', label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'private-key', label: 'Private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'generic-assignment', label: 'Hard-coded secret', pattern: /(?:api[_-]?key|secret|passwd|password|token)["'\s]*[:=]["'\s]*[0-9A-Za-z/+_-]{16,}/i }
];

/**
 * @param {string} text  the added lines of a diff, newline-separated
 * @param {string} file  the path the text belongs to, for the report
 * @returns {{ file: string, line: number, rule: string, label: string }[]}
 */
export function scanText(text, file) {
  if (typeof text !== 'string' || !text) return [];
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(lines[i])) {
        findings.push({ file, line: i + 1, rule: rule.id, label: rule.label });
        break; // one finding per line is enough to make the point
      }
    }
  }
  return findings;
}
