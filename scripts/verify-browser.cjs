/**
 * Verify headless Chromium actually launches on this server and that the
 * stealth wrapper used by refresh-session.cjs loads correctly.
 * No credentials, no login — just a real browser doing a real page load.
 */
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const version = browser.version();
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  // 1. A trivial page — proves rendering works.
  await page.setContent('<h1 id="t">ok</h1>');
  const text = await page.textContent('#t');

  // 2. A real HTTPS page — proves TLS + network work.
  let status = 'n/a';
  let title = 'n/a';
  try {
    const resp = await page.goto('https://api.coindcx.com/exchange/ticker', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    status = resp ? resp.status() : 'no-response';
    title = (await page.title()).slice(0, 40);
  } catch (e) {
    status = 'ERROR: ' + e.message.slice(0, 80);
  }

  // 3. Does the CoinDCX login page load at all (bot-protection check)?
  let loginStatus = 'n/a';
  try {
    const resp = await page.goto('https://coindcx.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    loginStatus = resp ? resp.status() : 'no-response';
    const fields = await page.evaluate(
      () => document.querySelectorAll('input').length
    );
    console.log('[verify] login page input count:', fields);
  } catch (e) {
    loginStatus = 'ERROR: ' + e.message.slice(0, 80);
  }

  console.log('[verify] browser version   :', version);
  console.log('[verify] DOM render test   :', text === 'ok' ? 'PASS' : 'FAIL');
  console.log('[verify] coindcx API status:', status);
  console.log('[verify] coindcx login page:', loginStatus);

  await browser.close();
  console.log('[verify] DONE');
})().catch((err) => {
  console.error('[verify] FAILED:', err.message);
  process.exit(1);
});
