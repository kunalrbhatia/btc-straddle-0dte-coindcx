#!/usr/bin/env node

/**
 * Pre-commit hook: Secret & sensitive file scanner
 *
 * Checks staged files for:
 * 1. Accidental commitment of sensitive files (.env, session.token, private keys)
 * 2. High-risk secret patterns: JWT bearer tokens, sensitive variables with non-placeholder values
 * 3. TruffleHog scanner execution if installed locally (optional with explicit notification)
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');

// Explicit override check
if (process.env.SKIP_SECRET_SCAN === '1') {
  console.warn('⚠️ [Pre-commit] SKIP_SECRET_SCAN=1 override is active. Skipping secret scanning.');
  process.exit(0);
}

// 1. Inspect staged files
let stagedFiles = [];
try {
  const output = execSync('git diff --cached --name-only --diff-filter=ACM', {
    encoding: 'utf8',
  });
  stagedFiles = output
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
} catch (err) {
  console.error('[Pre-commit] Error inspecting git staged files:', err.message);
  process.exit(1);
}

if (stagedFiles.length === 0) {
  process.exit(0);
}

// 2. Block prohibited sensitive files from ever being staged
const BLOCKED_FILE_PATTERNS = [
  /^\.env$/i,
  /^\.env\.local$/i,
  /^\.env\.production$/i,
  /^session\.token$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.id_rsa$/i,
];

const blockedStaged = stagedFiles.filter((file) =>
  BLOCKED_FILE_PATTERNS.some((pattern) => pattern.test(path.basename(file)))
);

if (blockedStaged.length > 0) {
  console.error('\n🚨 [PRE-COMMIT BLOCKED] Attempting to commit forbidden sensitive file(s):');
  blockedStaged.forEach((f) => console.error(`   ❌ ${f}`));
  console.error('\nUnstage these files immediately using:');
  console.error(`   git reset HEAD ${blockedStaged.join(' ')}\n`);
  process.exit(1);
}

// 3. Secret Pattern Definitions
const SENSITIVE_VAR_NAMES = [
  'COINDCX_BEARER_TOKEN',
  'COINDCX_API_SECRET',
  'COINDCX_WEB_PASSWORD',
  'COINDCX_TOTP_SECRET',
  'GMAIL_APP_PASSWORD',
  'TELEGRAM_BOT_TOKEN',
  'SESSION_TOKEN',
];

// Three-part base64url JWT: eyJ... . eyJ... . ...
const JWT_PATTERN = /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/;

const SENSITIVE_VAR_REGEX = new RegExp(
  `(?:${SENSITIVE_VAR_NAMES.join('|')})\\s*[:=]\\s*(["']?)([^"'\\s\r\n;,]+)\\1`,
  'i'
);

const TELEGRAM_TOKEN_REGEX = /\b\d{8,10}:[a-zA-Z0-9_-]{35}\b/;
const PRIVATE_KEY_HEADER_REGEX = /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PRIVATE) KEY-----/;

// Known placeholder and fixture patterns
const PLACEHOLDER_REGEX = /^(?:<[^>]+>|changeme|placeholder|your[-_]?\w*)$/i;
const FIXTURE_REGEX = /(?:sim-|test|dummy|fake|example)/i;

/**
 * Checks a line of added content for potential secrets.
 * Returns pattern name if secret is detected, or null if clean.
 */
function checkLineForSecret(line) {
  // Inline escape hatch: pragma: allowlist secret
  if (/pragma:\s*allowlist\s*secret/i.test(line)) {
    return null;
  }

  // Check 1: Three-part base64url JWT
  const jwtMatch = line.match(JWT_PATTERN);
  if (jwtMatch) {
    return 'JWT / Bearer Token';
  }

  // Check 2: Sensitive variable assignments with non-placeholder values
  const varMatch = line.match(SENSITIVE_VAR_REGEX);
  if (varMatch) {
    const rawVal = varMatch[2].trim();
    // Allow empty values
    if (rawVal.length === 0) {
      return null;
    }
    // Allow known placeholders
    if (PLACEHOLDER_REGEX.test(rawVal)) {
      return null;
    }
    // Allow test-suite fixtures (e.g. 'valid-bearer-token', 'test-secret')
    if (FIXTURE_REGEX.test(rawVal)) {
      return null;
    }
    return `Sensitive variable assignment (${varMatch[0].split(/[:=]/)[0].trim()})`;
  }

  // Check 3: Telegram bot token
  const tgMatch = line.match(TELEGRAM_TOKEN_REGEX);
  if (tgMatch) {
    const val = tgMatch[0];
    if (!FIXTURE_REGEX.test(val) && !PLACEHOLDER_REGEX.test(val)) {
      return 'Telegram Bot Token';
    }
  }

  // Check 4: Private key header
  if (PRIVATE_KEY_HEADER_REGEX.test(line)) {
    return 'Private Key Header';
  }

  return null;
}

// 4. Scan staged file diffs
const findings = [];

for (const file of stagedFiles) {
  // Allow template files and the scanner's own test files
  if (
    file === '.env.example' ||
    file.endsWith('pre-commit-secrets.test.ts') ||
    file.endsWith('pre-commit-secrets.cjs') ||
    file.endsWith('.png') ||
    file.endsWith('.ico')
  ) {
    continue;
  }

  let diff = '';
  try {
    diff = execSync(`git diff --cached -U0 --text -- "${file}"`, { encoding: 'utf8' });
  } catch {
    continue;
  }

  const diffLines = diff.split('\n');
  let currentLineNum = 0;

  for (const rawLine of diffLines) {
    // Parse hunk header: @@ -start,count +start,count @@
    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLineNum = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      const addedContent = rawLine.substring(1);
      const matchedPattern = checkLineForSecret(addedContent);

      if (matchedPattern) {
        findings.push({
          file,
          line: currentLineNum,
          pattern: matchedPattern,
        });
      }
      currentLineNum++;
    } else if (!rawLine.startsWith('-')) {
      currentLineNum++;
    }
  }
}

if (findings.length > 0) {
  console.error('\n🚨 [PRE-COMMIT BLOCKED] Potential secret(s) detected:');
  for (const f of findings) {
    console.error(`   ❌ ${f.file}:${f.line} [${f.pattern}]`);
  }
  console.error('\nCommit aborted. Never commit active credentials into the repository.');
  console.error('Use placeholders (<placeholder>), test fixtures, or inline "pragma: allowlist secret" to proceed.\n');
  process.exit(1);
}

// 5. Run TruffleHog if installed locally (with clear optional status)
const checkTh = spawnSync('trufflehog', ['--version'], { shell: true });
if (checkTh.status === 0) {
  const thResult = spawnSync(
    'trufflehog',
    ['git', 'file://.', '--no-update', '--since-commit', 'HEAD'],
    { stdio: 'inherit', shell: true }
  );
  if (thResult.status !== 0) {
    console.error('\n🚨 [PRE-COMMIT BLOCKED] TruffleHog detected potential secrets.\n');
    process.exit(1);
  }
} else {
  console.warn('⚠️ [Pre-commit] TruffleHog not installed — pattern scan only.');
}

console.log('✅ [Pre-commit] Secret scan passed. No secrets detected.');
process.exit(0);

// Export for unit tests
if (typeof module !== 'undefined') {
  module.exports = {
    checkLineForSecret,
    SENSITIVE_VAR_NAMES,
    JWT_PATTERN,
  };
}
