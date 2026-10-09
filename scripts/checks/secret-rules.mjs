import assert from 'node:assert/strict';
import { SECRET_RULES, scanText } from '../../renderer/src/features/automations/secret-rules.js';

assert.ok(SECRET_RULES.length >= 5);

const samples = {
  'aws-access-key': 'const key = "AKIAIOSFODNN7EXAMPLE";',
  'github-token': 'TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4a',
  'slack-token': 'xoxb-2345678901-2345678901234-AbCdEfGhIjKlMnOpQrStUvWx',
  'google-api-key': `AIza${'B'.repeat(35)}`,
  'private-key': '-----BEGIN OPENSSH PRIVATE KEY-----',
  // Built from parts so the repository itself holds no token-shaped string.
  'github-fine-grained-token': `${'github'}_pat_${'A1b2'.repeat(15)}`,
  'gitlab-token': `${'glpat'}-${'x1Y2'.repeat(5)}`,
  'stripe-key': `${'sk'}_live_${'Z9y8'.repeat(6)}`,
  'anthropic-key': `${'sk'}-ant-api03-${'q'.repeat(30)}`,
  'openai-key': `${'sk'}-proj-${'a'.repeat(24)}${'T3Blbk'}FJ${'b'.repeat(24)}`,
  'slack-webhook': `https://hooks.${'slack'}.com/services/T0ABC1234/B0DEF5678/${'c'.repeat(24)}`,
  'telegram-bot-token': `123456789:AA${'d'.repeat(33)}`,
  'npm-token': `${'npm'}_${'e'.repeat(36)}`,
  'url-password': 'remote = https://deploy:hunter2pass@git.example.com/x.git'
};
assert.equal(scanText('-----BEGIN ENCRYPTED PRIVATE KEY-----', 'k.pem')[0]?.rule, 'private-key');
assert.equal(scanText('-----BEGIN PGP PRIVATE KEY BLOCK-----', 'k.asc')[0]?.rule, 'private-key');
assert.deepEqual(scanText('ssh://git@github.com/a/b.git', 'a.txt'), [], 'a bare SSH user is not a password');
for (const [rule, line] of Object.entries(samples)) {
  const findings = scanText(line, 'secrets.txt');
  assert.equal(findings.length, 1, `${rule}: one finding`);
  assert.equal(findings[0].rule, rule);
  assert.equal(findings[0].file, 'secrets.txt');
  assert.equal(findings[0].line, 1);
}

// A generic hard-coded assignment is caught even without a known vendor prefix.
assert.equal(scanText('  api_key: "s3cr3tListedValueHere12345"', 'a.yml').length, 1);

// Ordinary code produces nothing.
const clean = ['function add(a, b) { return a + b; }', 'const url = "https://example.com/docs";', 'import x from "./x.js";'].join('\n');
assert.deepEqual(scanText(clean, 'a.js'), []);
assert.deepEqual(scanText('', 'a.js'), []);

// Line numbers point at the offending line.
const multi = scanText(['ok line', 'ok line', 'password = "abcdef0123456789abcdef"'].join('\n'), 'c.env');
assert.equal(multi[0].line, 3);

console.log('Secret rule checks passed: known credential formats detected, clean code clean, line numbers correct.');
