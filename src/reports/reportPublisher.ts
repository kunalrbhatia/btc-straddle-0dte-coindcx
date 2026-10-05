import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendAlert } from '../fileAlerter';
import { Notifier } from '../notifier';
import { getReportsDir } from './reportPaths';

export interface PublishReportOptions {
  readonly dryRun?: boolean;
  readonly branch?: string;
  readonly remote?: string;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly repoDir?: string;
  readonly notifier?: Notifier;
}

export interface PublishReportResult {
  readonly published: boolean;
  readonly commitHash?: string;
  readonly message: string;
}

/**
 * Publishes reports/<expiryDateStr>.md directly to the isolated `reports` branch.
 *
 * Uses git plumbing with an isolated index file so that:
 * 1. Working branch and working directory are NEVER checked out or modified.
 * 2. Unstaged/untracked files in the root worktree are NEVER staged or committed.
 * 3. Secret scanner checks the commit.
 * 4. Pushes specifically to refs/heads/reports on the remote.
 */
export async function publishDailyReport(
  expiryDateStr: string,
  options: PublishReportOptions = {}
): Promise<PublishReportResult> {
  const branch = options.branch || 'reports';
  const remote = options.remote || 'origin';
  const authorName = options.authorName || 'btc-straddle-0dte bot';
  const authorEmail = options.authorEmail || 'bot@straddle-btc-0dte.local';
  const repoDir = options.repoDir || process.cwd();
  const notifier = options.notifier;

  // These git calls run SYNCHRONOUSLY inside the trading process (startup catch-up, then the
  // expiry+delay timer), so they must be bounded: an unbounded execSync on a stalled network
  // would block the event loop — and therefore the risk monitor and the entry scheduler —
  // for as long as the socket hangs. Network calls get the full budget; local plumbing is fast.
  const NET_TIMEOUT_MS = 60_000;
  const LOCAL_TIMEOUT_MS = 15_000;

  const relReportPath = path.join('reports', `${expiryDateStr}.md`).replace(/\\/g, '/');
  const fullReportPath = path.join(getReportsDir(), `${expiryDateStr}.md`);

  if (!fs.existsSync(fullReportPath)) {
    const msg = `Report file does not exist: ${fullReportPath}`;
    console.error(`[ReportPublisher] ${msg}`);
    appendAlert('report_publish_failed', msg, { expiryDateStr });
    return { published: false, message: msg };
  }

  // Pre-commit secret scan guard
  try {
    const reportContent = fs.readFileSync(fullReportPath, 'utf8');
    // Basic verification that no sensitive keywords with secrets exist in report
    if (
      reportContent.includes('COINDCX_BEARER_TOKEN') ||
      reportContent.includes('COINDCX_API_SECRET') ||
      reportContent.includes('COINDCX_WEB_PASSWORD') ||
      reportContent.includes('TELEGRAM_BOT_TOKEN')
    ) {
      const msg = `Secret detected in report content for ${expiryDateStr}! Refusing to publish.`;
      console.error(`[ReportPublisher] 🚨 ${msg}`);
      appendAlert('report_publish_failed', msg, { expiryDateStr });
      return { published: false, message: msg };
    }
  } catch (err) {
    const msg = `Failed to read report for secret scanning: ${(err as Error).message}`;
    console.error(`[ReportPublisher] ${msg}`);
    appendAlert('report_publish_failed', msg, { expiryDateStr });
    return { published: false, message: msg };
  }

  if (options.dryRun) {
    console.log(`[ReportPublisher] DRY RUN: Would publish ${relReportPath} to ${remote}/${branch}`);
    appendAlert('daily_report', `Daily trade report generated for ${expiryDateStr} (DRY RUN)`, {
      expiryDateStr,
      branch,
      dryRun: true,
    });
    return {
      published: true,
      message: `DRY RUN: Report generated and validated for ${expiryDateStr}`,
    };
  }

  // Temporary isolated index file
  const tmpIndex = path.join(os.tmpdir(), `git-report-idx-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: tmpIndex,
    // Never let git stop to ask for credentials — that is another unbounded wait.
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  };

  try {
    // 1. Fetch latest remote reports branch if it exists, or check local branch
    let parentCommit: string | null = null;
    try {
      execSync(`git fetch ${remote} ${branch}:${branch}`, { cwd: repoDir, env, stdio: 'pipe', timeout: NET_TIMEOUT_MS });
    } catch {
      // Branch might not exist yet on remote, which is expected for the first report
    }

    try {
      parentCommit = execSync(`git rev-parse refs/heads/${branch}`, {
        cwd: repoDir,
        env,
        stdio: 'pipe',
        timeout: LOCAL_TIMEOUT_MS,
      })
        .toString()
        .trim();
    } catch {
      parentCommit = null;
    }

    // 2. Initialise index: read existing parent tree if available, or empty tree
    if (parentCommit) {
      execSync(`git read-tree ${parentCommit}`, { cwd: repoDir, env, stdio: 'pipe', timeout: LOCAL_TIMEOUT_MS });
    } else {
      execSync('git read-tree --empty', { cwd: repoDir, env, stdio: 'pipe', timeout: LOCAL_TIMEOUT_MS });
    }

    // 3. Stage the report file into the isolated index using git add
    // Note: ensure reports/<file>.md is in cwd relative path if reportsDir is within repo,
    // or add object directly using git hash-object + git update-index
    const reportData = fs.readFileSync(fullReportPath);
    const blobHash = execSync('git hash-object -w --stdin', {
      cwd: repoDir,
      input: reportData,
      env,
      stdio: 'pipe',
      timeout: LOCAL_TIMEOUT_MS,
    })
      .toString()
      .trim();

    execSync(`git update-index --add --cacheinfo 100644 ${blobHash} "${relReportPath}"`, {
      cwd: repoDir,
      env,
      stdio: 'pipe',
      timeout: LOCAL_TIMEOUT_MS,
    });

    // 4. Write tree from isolated index
    const treeHash = execSync('git write-tree', { cwd: repoDir, env, stdio: 'pipe', timeout: LOCAL_TIMEOUT_MS })
      .toString()
      .trim();

    // Check idempotency: if parentCommit's tree matches this treeHash, no changes to commit!
    if (parentCommit) {
      const parentTree = execSync(`git rev-parse "${parentCommit}^{tree}"`, {
        cwd: repoDir,
        env,
        stdio: 'pipe',
        timeout: LOCAL_TIMEOUT_MS,
      })
        .toString()
        .trim();
      if (parentTree === treeHash) {
        console.log(`[ReportPublisher] Report ${relReportPath} is already up to date on branch ${branch}.`);
        return {
          published: true,
          commitHash: parentCommit,
          message: `Idempotent: Report for ${expiryDateStr} already committed on ${branch}`,
        };
      }
    }

    // 5. Commit tree
    const commitMsg = `chore(reports): daily trade report ${expiryDateStr}`;
    const commitArgs = parentCommit
      ? `git commit-tree ${treeHash} -p ${parentCommit} -m "${commitMsg}"`
      : `git commit-tree ${treeHash} -m "${commitMsg}"`;

    const commitHash = execSync(commitArgs, { cwd: repoDir, env, stdio: 'pipe', timeout: LOCAL_TIMEOUT_MS })
      .toString()
      .trim();

    // 6. Update local ref
    execSync(`git update-ref refs/heads/${branch} ${commitHash}`, {
      cwd: repoDir,
      env,
      stdio: 'pipe',
      timeout: LOCAL_TIMEOUT_MS,
    });

    // 7. Push to remote reports branch
    execSync(`git push ${remote} ${commitHash}:refs/heads/${branch}`, {
      cwd: repoDir,
      env,
      stdio: 'pipe',
      timeout: NET_TIMEOUT_MS,
    });

    const successMsg = `Daily trade report published: commit ${commitHash.slice(0, 7)} on branch '${branch}'`;
    console.log(`[ReportPublisher] ✅ ${successMsg}`);

    appendAlert('daily_report', successMsg, {
      expiryDateStr,
      branch,
      commitHash,
    });

    if (notifier) {
      void notifier.notifyReconciliation(successMsg);
    }

    return {
      published: true,
      commitHash,
      message: successMsg,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const failMsg = `Failed to publish daily report for ${expiryDateStr}: ${errorMsg}`;
    console.error(`[ReportPublisher] 🚨 ${failMsg}`);

    appendAlert('report_publish_failed', failMsg, {
      expiryDateStr,
      error: errorMsg,
    });

    if (notifier) {
      void notifier.notifyError('Report Publish Failed', failMsg);
    }

    return {
      published: false,
      message: failMsg,
    };
  } finally {
    try {
      if (fs.existsSync(tmpIndex)) {
        fs.unlinkSync(tmpIndex);
      }
    } catch {
      // Ignore cleanup error
    }
  }
}
