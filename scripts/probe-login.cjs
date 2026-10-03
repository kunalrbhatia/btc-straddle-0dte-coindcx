/**
 * Probe the CoinDCX login page properly: give the SPA time to render, then
 * report the final URL, input fields, frames, and visible button text.
 * This tells us whether the refresher can actually drive the login form.
 */
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const authCalls = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/coindcx\.com/.test(u) && /(login|auth|token|otp|session|signin|refresh)/i.test(u)) {
      authCalls.push(`${r.method()} ${u.replace(/^https?:\/\//, '').slice(0, 110)}`);
    }
  });

  console.log('[probe] loading https://coindcx.com/login ...');
  const resp = await page.goto('https://coindcx.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  console.log('[probe] status:', resp ? resp.status() : 'none');

  // Give the SPA time to hydrate and settle.
  await page.waitForTimeout(12000);
  try {
    await page.waitForLoadState('networkidle', { timeout: 20000 });
  } catch {
    /* fine */
  }

  console.log('[probe] final URL:', page.url());
  console.log('[probe] title    :', await page.title());

  const info = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).map((el) => ({
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      ph: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '',
      visible: Boolean(el.offsetParent),
    }));
    const buttons = Array.from(document.querySelectorAll('button'))
      .map((b) => (b.innerText || '').trim().slice(0, 30))
      .filter(Boolean);
    const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400);
    return { inputs, buttons, bodyText, frames: window.frames.length };
  });

  console.log('[probe] input count:', info.inputs.length);
  console.log('[probe] inputs:', JSON.stringify(info.inputs, null, 1));
  console.log('[probe] buttons:', JSON.stringify(info.buttons.slice(0, 15)));
  console.log('[probe] frames:', info.frames);
  console.log('[probe] body text:', info.bodyText);

  await page.screenshot({ path: '/tmp/cdx_login.png' }).catch(() => {});
  console.log('[probe] auth-ish requests seen:', JSON.stringify(authCalls.slice(0, 15), null, 1));
  console.log('[probe] screenshot: /tmp/cdx_login.png');

  await browser.close();
})().catch((e) => {
  console.error('[probe] FAILED:', e.message);
  process.exit(1);
});
