import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { alertFilePath, appendAlert, resetAlertDedup } from './fileAlerter';

/**
 * The alert journal is relayed verbatim to Telegram by the Hermes watch banner, so
 * a per-poll failure used to become a message per poll (~2/second for hours on
 * 2026-10-05). These tests pin the collapsing rule: first occurrence always
 * written, exact repeats inside the window dropped, next emission after the window
 * carries the suppressed count — and alerts without a dedup key are unchanged.
 */
describe('FileAlerter dedup', () => {
  const readJournal = (): Array<{ kind: string; message: string }> => {
    const p = alertFilePath();
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  };

  const startFresh = (): void => {
    resetAlertDedup();
    const p = alertFilePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  };

  beforeEach(() => {
    startFresh();
  });

  it('collapses identical repeats inside the window to a single journal line', () => {
    for (let i = 0; i < 50; i++) {
      appendAlert('feed_unavailable', 'Price feed unavailable for PUT X', { leg: 'PUT' }, {
        dedupKey: 'feed_unavailable:BTC-X-P',
        windowMs: 60_000,
      });
    }

    const lines = readJournal().filter((l) => l.kind === 'feed_unavailable');
    assert.equal(lines.length, 1, 'expected exactly one line for 50 identical repeats');
    assert.equal(lines[0].message, 'Price feed unavailable for PUT X');
  });

  it('re-emits after the window and reports how many repeats were suppressed', async () => {
    const opts = { dedupKey: 'feed_unavailable:BTC-X-P', windowMs: 60 };
    appendAlert('feed_unavailable', 'Price feed unavailable for PUT X', undefined, opts);
    appendAlert('feed_unavailable', 'Price feed unavailable for PUT X', undefined, opts);
    appendAlert('feed_unavailable', 'Price feed unavailable for PUT X', undefined, opts);

    await new Promise((r) => setTimeout(r, 80));
    appendAlert('feed_unavailable', 'Price feed unavailable for PUT X', undefined, opts);

    const lines = readJournal().filter((l) => l.kind === 'feed_unavailable');
    assert.equal(lines.length, 2, 'expected the window to re-open exactly once');
    assert.match(lines[1].message, /\[2 repeat\(s\) suppressed/);
  });

  it('keeps different keys independent', () => {
    const window = { windowMs: 60_000 };
    appendAlert('feed_unavailable', 'CALL leg down', undefined, {
      ...window,
      dedupKey: 'feed_unavailable:BTC-X-C',
    });
    appendAlert('feed_unavailable', 'PUT leg down', undefined, {
      ...window,
      dedupKey: 'feed_unavailable:BTC-X-P',
    });

    const lines = readJournal().filter((l) => l.kind === 'feed_unavailable');
    assert.equal(lines.length, 2);
  });

  it('writes every alert when no dedup key is given (unchanged behaviour)', () => {
    for (let i = 0; i < 5; i++) {
      appendAlert('exit_failure_permanent', 'MANUAL ACTION NEEDED: leg still open');
    }

    const lines = readJournal().filter((l) => l.kind === 'exit_failure_permanent');
    assert.equal(lines.length, 5, 'actionable alerts must never be silently collapsed');
  });
});
