import assert from 'node:assert/strict';
import { SECRET_RULES, scanText } from '../../renderer/src/features/automations/secret-rules.js';

assert.ok(SECRET_RULES.length >= 5);

const samples = {
  'aws-access-key': 'const key = "AKIAIOSFODNN7EXAMPLE";',
  'github-token': 'TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4a',
  'slack-token': 'xoxb-2345678901-2345678901234-AbCdEfGhIjKlMnOpQrStUvWx',
  'google-api-key': `AIza${'B'.repeat(35)}`,
  'private-key': '-----BEGIN OPENSSH PRIVATE KEY-----'
};
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
