#!/usr/bin/env node

/**
 * Pre-commit hook: Secret & sensitive file scanner
 *
 * Checks staged files for:
 * 1. Accidental commitment of sensitive files (.env, session.token, private keys)
 * 2. High-risk secret patterns (API keys, secrets, JWT session tokens, TOTP secrets)
 * 3. TruffleHog scanner execution if installed locally
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

// 3. Scan staged file diffs for high-risk secret signatures
const SECRET_REGEXES = [
  {
    name: 'CoinDCX API Key/Secret assignment',
    regex: /(?:COINDCX_API_KEY|COINDCX_API_SECRET)\s*[:=]\s*["']?[a-zA-Z0-9_\-]{16,}["']?/i,
  },
  {
    name: 'CoinDCX JWT Session Token',
    regex: /(?:COINDCX_SESSION_TOKEN|Bearer)\s*[:=]?\s*["']?eyJ[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]{20,}["']?/i,
  },
  {
    name: 'Gmail App Password',
    regex: /GMAIL_APP_PASSWORD\s*[:=]\s*["']?[a-z]{4}\s*[a-z]{4}\s*[a-z]{4}\s*[a-z]{4}["']?/i,
  },
  {
    name: 'CoinDCX Web Password',
    regex: /COINDCX_WEB_PASSWORD\s*[:=]\s*["']?[^"'\s]{6,}["']?/i,
  },
  {
    name: 'TOTP Secret (Base32 16+ chars)',
    regex: /COINDCX_TOTP_SECRET\s*[:=]\s*["']?[A-Z2-7]{16,}["']?/i,
  },
  {
    name: 'Telegram Bot Token',
    regex: /\b\d{8,10}:[a-zA-Z0-9_-]{35}\b/,
  },
  {
    name: 'Private Key Header',
    regex: /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PRIVATE) KEY-----/,
  },
];

let foundSecret = false;

for (const file of stagedFiles) {
  // Skip binary or example template files
  if (file === '.env.example' || file.endsWith('.png') || file.endsWith('.ico')) {
    continue;
  }

  // Only inspect newly added lines in the diff
  let addedLines = '';
  try {
    const diff = execSync(`git diff --cached --text -- "${file}"`, { encoding: 'utf8' });
    addedLines = diff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.substring(1))
      .filter((l) => !/placeholder|your_|your-|example|foo|bar/i.test(l))
      .join('\n');
  } catch {}

  for (const rule of SECRET_REGEXES) {
    if (rule.regex.test(addedLines)) {
      console.error(`\n🚨 [PRE-COMMIT BLOCKED] Potential secret detected in staged file: ${file}`);
      console.error(`   Detected rule: ${rule.name}`);
      foundSecret = true;
    }
  }
}

if (foundSecret) {
  console.error('\nCommit aborted. Please remove sensitive credentials before committing.\n');
  process.exit(1);
}

// 4. Run TruffleHog if installed locally
try {
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
  }
} catch {
  // TruffleHog optional fallback if command fails to spawn
}

console.log('✅ [Pre-commit] Secret scan passed. No secrets detected.');
process.exit(0);
