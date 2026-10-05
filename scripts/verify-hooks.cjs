#!/usr/bin/env node

/**
 * Verifies that Git hooks are active in the local repository clone.
 */

const { execSync } = require('child_process');

try {
  const currentHooks = execSync('git config core.hooksPath', { encoding: 'utf8' }).trim();
  if (currentHooks === '.githooks') {
    console.log('✅ Git hooks are active: core.hooksPath is set to .githooks');
    process.exit(0);
  } else {
    console.warn(`⚠️ Git hooks are misconfigured: core.hooksPath is set to "${currentHooks}" (expected: .githooks)`);
    console.warn('Run "npm run prepare" or "git config core.hooksPath .githooks" to enable them.');
    process.exit(1);
  }
} catch {
  console.error('❌ Git hooks are NOT active in this clone: core.hooksPath is not configured.');
  console.error('Run "npm run prepare" or "git config core.hooksPath .githooks" to enable them.');
  process.exit(1);
}
