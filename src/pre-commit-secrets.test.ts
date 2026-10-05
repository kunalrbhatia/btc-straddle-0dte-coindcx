import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import path from 'path';

// Import scanner detection logic directly
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkLineForSecret } = require('../scripts/pre-commit-secrets.cjs');

describe('Pre-Commit Secret Scanner Unit Tests', () => {
  describe('checkLineForSecret unit matching', () => {
    it('catches three-part base64url JWT bearer token', () => {
      const line = 'const token = "eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjoiZmFrZSJ9.ZmFrZQ1234567890";';
      const result = checkLineForSecret(line);
      assert.notEqual(result, null);
      assert.match(result as string, /JWT \/ Bearer Token/i);
    });

    it('catches sensitive repo variable assigned a realistic secret', () => {
      const line = 'COINDCX_BEARER_TOKEN="somerandomsecrettokenvalue123456"';
      const result = checkLineForSecret(line);
      assert.notEqual(result, null);
      assert.match(result as string, /Sensitive variable assignment/i);
    });

    it('catches COINDCX_API_SECRET, GMAIL_APP_PASSWORD, TELEGRAM_BOT_TOKEN', () => {
      assert.notEqual(
        checkLineForSecret('COINDCX_API_SECRET=9876543210abcdef9876543210'),
        null
      );
      assert.notEqual(
        checkLineForSecret('GMAIL_APP_PASSWORD=abcd efgh ijkl mnop'),
        null
      );
      assert.notEqual(
        checkLineForSecret('const botToken = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ123456789";'),
        null
      );
    });

    it('allows empty values and placeholders (<placeholder>, KEY=)', () => {
      assert.equal(checkLineForSecret('COINDCX_BEARER_TOKEN='), null);
      assert.equal(checkLineForSecret('COINDCX_BEARER_TOKEN=""'), null);
      assert.equal(checkLineForSecret('COINDCX_BEARER_TOKEN=<your-token>'), null);
      assert.equal(checkLineForSecret('COINDCX_API_SECRET=<placeholder>'), null);
      assert.equal(checkLineForSecret('GMAIL_APP_PASSWORD=changeme'), null);
      assert.equal(checkLineForSecret('TELEGRAM_BOT_TOKEN=your_bot_token'), null);
    });

    it('allows test-suite fixtures (valid-bearer-token, test-secret, dummy, sim-)', () => {
      assert.equal(checkLineForSecret("apiKey: 'test-key'"), null);
      assert.equal(checkLineForSecret("apiSecret: 'test-secret'"), null);
      assert.equal(checkLineForSecret("bearerToken: 'valid-bearer-token'"), null);
      assert.equal(checkLineForSecret("COINDCX_SESSION_TOKEN='fake-token'"), null);
      assert.equal(checkLineForSecret("password: 'dummy-password'"), null);
      assert.equal(checkLineForSecret("session: 'sim-session-123'"), null);
    });

    it('respects inline pragma: allowlist secret escape hatch', () => {
      const lineWithPragma =
        'COINDCX_BEARER_TOKEN="eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjoiZmFrZSJ9.ZmFrZQ1234567890" // pragma: allowlist secret';
      assert.equal(checkLineForSecret(lineWithPragma), null);
    });
  });

  describe('Scanner process execution & output safety', () => {
    const scriptPath = path.resolve(__dirname, '../scripts/pre-commit-secrets.cjs');

    it('exits 0 on clean tree with no staged files', () => {
      const res = spawnSync('node', [scriptPath], {
        encoding: 'utf8',
        shell: true,
      });
      assert.equal(res.status, 0);
      assert.match(res.stdout, /Secret scan passed|SKIP_SECRET_SCAN/i);
    });

    it('respects SKIP_SECRET_SCAN=1 override', () => {
      const res = spawnSync('node', [scriptPath], {
        encoding: 'utf8',
        shell: true,
        env: {
          ...process.env,
          SKIP_SECRET_SCAN: '1',
        },
      });
      assert.equal(res.status, 0);
      assert.match(res.stdout, /SKIP_SECRET_SCAN=1 override is active/i);
    });

    it('never prints the secret value in the blocked output', () => {
      // Simulate by inspecting how checkLineForSecret output is formatted in the script
      const secretVal = 'eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjoiZmFrZSJ9.ZmFrZQ1234567890';
      const line = `const key = "${secretVal}";`;
      const detectedPattern = checkLineForSecret(line);
      assert.notEqual(detectedPattern, null);

      // Verify that pattern description does NOT contain the secret value
      assert.equal((detectedPattern as string).includes(secretVal), false);
    });
  });
});
