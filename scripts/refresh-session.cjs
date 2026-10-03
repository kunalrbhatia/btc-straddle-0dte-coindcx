/**
 * Headless Automated Session Refresh for CoinDCX
 *
 * Automates login on headless servers via Playwright with stealth plugin:
 * 1. Submits Email & Password.
 * 2. Fetches 6-digit Email OTP from Gmail via secure TLS IMAP in real time.
 * 3. Generates 6-digit Google Authenticator TOTP from decoded secret.
 * 4. Fills both OTP fields and confirms login.
 * 5. Captures Bearer JWT session token from request headers / response payload.
 * 6. Writes fresh token directly to `session.token`.
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const { ImapFlow } = require('imapflow');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const EMAIL = process.env.COINDCX_WEB_EMAIL;
const PASSWORD = process.env.COINDCX_WEB_PASSWORD;
const TOTP_SECRET = process.env.COINDCX_TOTP_SECRET;
const GMAIL_USER = process.env.GMAIL_USER || EMAIL;
const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
const TOKEN_FILE = path.join(__dirname, '..', 'session.token');
const USER_DATA_DIR = path.join(__dirname, '..', 'state', 'browser-profile');

if (!EMAIL || !PASSWORD) {
  console.error('❌ COINDCX_WEB_EMAIL and COINDCX_WEB_PASSWORD must be set in .env');
  process.exit(1);
}

// ---------------------------------------------------------
// Helper 1: TOTP Generation from Google Authenticator export
// ---------------------------------------------------------
function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const output = [];
  const clean = str.replace(/=+$/, '').toUpperCase();
  for (let i = 0; i < clean.length; i++) {
    const idx = alphabet.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function parseSecretBytes(secretRaw) {
  if (!secretRaw) return null;
  const clean = secretRaw.trim();
  if (clean.length === 16 || clean.length === 32) {
    if (/^[A-Z2-7]+=*$/i.test(clean)) {
      return base32Decode(clean);
    }
  }
  // Try protobuf unpack
  try {
    const buf = Buffer.from(clean, 'base64');
    let offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset++];
      const wire = tag & 0x07;
      const field = tag >> 3;
      if (wire === 2) {
        let len = 0;
        let shift = 0;
        while (offset < buf.length) {
          const b = buf[offset++];
          len |= (b & 0x7f) << shift;
          if ((b & 0x80) === 0) break;
          shift += 7;
        }
        const data = buf.subarray(offset, offset + len);
        offset += len;
        if (field === 1) {
          let pOff = 0;
          while (pOff < data.length) {
            const pTag = data[pOff++];
            const pWire = pTag & 0x07;
            const pField = pTag >> 3;
            if (pWire === 2) {
              let pLen = 0;
              let pShift = 0;
              while (pOff < data.length) {
                const pb = data[pOff++];
                pLen |= (pb & 0x7f) << pShift;
                if ((pb & 0x80) === 0) break;
                pShift += 7;
              }
              const pData = data.subarray(pOff, pOff + pLen);
              pOff += pLen;
              if (pField === 1 && pData.length >= 10 && pData.length <= 32) {
                return pData;
              }
            } else if (pWire === 0) {
              while (pOff < data.length && (data[pOff++] & 0x80) !== 0) {}
            }
          }
        }
      } else if (wire === 0) {
        while (offset < buf.length && (buf[offset++] & 0x80) !== 0) {}
      }
    }
  } catch {
    // fallback
  }
  return base32Decode(clean);
}

function generateTOTP(secretBytes, timeOffsetSeconds = 0) {
  const epoch = Math.floor(Date.now() / 1000) + timeOffsetSeconds;
  const timeStep = 30;
  const counter = Math.floor(epoch / timeStep);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBytes).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return code.toString().padStart(6, '0');
}

// ---------------------------------------------------------
// Helper 2: Poll Gmail IMAP for CoinDCX Email OTP
// ---------------------------------------------------------
async function fetchEmailOtp(sinceTimestampMs, maxWaitSeconds = 45) {
  if (!GMAIL_PASS) {
    throw new Error('GMAIL_APP_PASSWORD is missing in .env');
  }

  console.log(`[GmailPoller] Waiting for CoinDCX OTP email via IMAP (max ${maxWaitSeconds}s)...`);
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    logger: false
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  const startTime = Date.now();
  try {
    while (Date.now() - startTime < maxWaitSeconds * 1000) {
      const messages = await client.search({ or: [{ subject: 'Your Email OTP' }, { subject: 'CoinDCX account' }] });
      if (messages && messages.length > 0) {
        // Check latest 3 messages
        const recentSeq = messages.slice(-3);
        for (let i = recentSeq.length - 1; i >= 0; i--) {
          const msg = await client.fetchOne(recentSeq[i], { source: true, envelope: true });
          const msgDate = new Date(msg.envelope.date).getTime();
          // Must be newer than 20 seconds before we started submitting
          if (msgDate >= sinceTimestampMs - 25000) {
            const body = msg.source.toString('utf8');
            const idx = body.indexOf('Password (OTP)');
            if (idx !== -1) {
              const snippet = body.substring(idx, idx + 1200);
              const match = snippet.match(/\b(\d{6})\b/);
              if (match) {
                const otp = match[1];
                console.log(`[GmailPoller] ✅ Successfully retrieved Email OTP: ${otp} (sent at ${msg.envelope.date})`);
                return otp;
              }
            }
          }
        }
      }
      // Wait 2.5s before next poll
      await new Promise(r => setTimeout(r, 2500));
    }
    throw new Error(`Timed out waiting for CoinDCX OTP email after ${maxWaitSeconds}s`);
  } finally {
    lock.release();
    await client.logout();
  }
}

// ---------------------------------------------------------
// Main Headless Login Automation
// ---------------------------------------------------------
async function refreshSession() {
  console.log('====================================================');
  console.log('      COINDCX AUTOMATED ZERO-TOUCH LOGIN            ');
  console.log('====================================================\n');

  const secretBytes = parseSecretBytes(TOTP_SECRET);
  if (!secretBytes) {
    console.error('❌ Could not parse COINDCX_TOTP_SECRET.');
    process.exit(1);
  }

  console.log('[StealthRefresher] Launching stealth browser...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-size=1920,1080',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();
  let capturedToken = null;

  // Intercept Authorization header from API calls
  page.on('request', (req) => {
    const auth = req.headers()['authorization'];
    if (auth && auth.startsWith('Bearer ') && auth.length > 50) {
      const candidate = auth.replace('Bearer ', '').trim();
      if (candidate.startsWith('eyJ')) {
        capturedToken = candidate;
        console.log('[StealthRefresher] 🎯 Captured token from Authorization header!');
      }
    }
  });

  // Intercept token from responses
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (url.includes('coindcx.com') && (url.includes('login') || url.includes('verify') || url.includes('auth') || url.includes('session'))) {
        const text = await res.text();
        const match = text.match(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/);
        if (match && !capturedToken) {
          capturedToken = match[0];
          console.log('[StealthRefresher] 🎯 Captured token from API response body:', url);
        }
      }
    } catch {
      // Ignore
    }
  });

  try {
    console.log('[StealthRefresher] Navigating to https://coindcx.com/login ...');
    await page.goto('https://coindcx.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    const emailSelector = 'input[type="text"][name="inputElement"], input[type="email"]';
    console.log('[StealthRefresher] Entering email...');
    await page.waitForSelector(emailSelector, { timeout: 25000 });
    await page.fill(emailSelector, EMAIL);
    await page.waitForTimeout(300);

    const passwordSelector = 'input[type="password"][name="inputElement"], input[type="password"]';
    console.log('[StealthRefresher] Entering password...');
    await page.waitForSelector(passwordSelector, { timeout: 20000 });
    await page.fill(passwordSelector, PASSWORD);
    await page.waitForTimeout(500);

    const submitTime = Date.now();
    console.log('[StealthRefresher] Submitting login credentials...');
    const submitBtn = await page.$('button[type="submit"], button:has-text("Login with Email"), button:has-text("Log In")');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

      console.log('[StealthRefresher] Waiting for 2FA / OTP verification screen...');
      await page.waitForTimeout(5000);

      // Check for OTP inputs
      const otpBoxSelector = 'input[autocomplete="one-time-code"], input[name*="otp"], input[type="tel"], input[inputmode="numeric"]';
      await page.waitForSelector(otpBoxSelector, { timeout: 15000 });

      // Fetch email OTP concurrently while preparing TOTP
      console.log('[StealthRefresher] Fetching email OTP and generating TOTP...');
      const emailOtpPromise = fetchEmailOtp(submitTime, 40);
      const liveTotp = generateTOTP(secretBytes);
      console.log(`[StealthRefresher] Live Google Authenticator TOTP: ${liveTotp}`);

      const emailOtp = await emailOtpPromise;
      const allOtpBoxes = await page.$$(otpBoxSelector);
      console.log(`[StealthRefresher] Found ${allOtpBoxes.length} OTP input boxes on page.`);

      if (allOtpBoxes.length >= 12) {
        // First 6 boxes: Email OTP
        console.log(`[StealthRefresher] Entering Email OTP (${emailOtp})...`);
        for (let i = 0; i < 6; i++) {
          await allOtpBoxes[i].fill(emailOtp[i]);
          await page.waitForTimeout(50);
        }
        // Next 6 boxes: TOTP
        console.log(`[StealthRefresher] Entering Authenticator TOTP (${liveTotp})...`);
        for (let i = 0; i < 6; i++) {
          await allOtpBoxes[6 + i].fill(liveTotp[i]);
          await page.waitForTimeout(50);
        }
      } else if (allOtpBoxes.length === 6) {
        // If single set, check page text
        const bodyText = await page.evaluate(() => document.body.innerText);
        if (bodyText.includes('email') || bodyText.includes('Email')) {
          console.log(`[StealthRefresher] Entering Email OTP (${emailOtp})...`);
          for (let i = 0; i < 6; i++) {
            await allOtpBoxes[i].fill(emailOtp[i]);
          }
        } else {
          console.log(`[StealthRefresher] Entering Authenticator TOTP (${liveTotp})...`);
          for (let i = 0; i < 6; i++) {
            await allOtpBoxes[i].fill(liveTotp[i]);
          }
        }
      }

      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'step-otp-filled.png' });

      console.log('[StealthRefresher] Submitting 2FA confirmation...');
      const confirmBtn = await page.$('button:has-text("Confirm"), button[type="submit"], button:has-text("Verify")');
      if (confirmBtn) {
        await confirmBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }

      await page.waitForTimeout(8000);
      await page.screenshot({ path: 'step-after-confirm.png' });

    // Navigate to options page to ensure options session token is requested
    console.log('[StealthRefresher] Navigating to options dashboard...');
    await page.goto('https://coindcx.com/options', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);

    // If request interception hasn't caught it, inspect localStorage & cookies
    if (!capturedToken) {
      console.log('[StealthRefresher] Inspecting browser storage & cookies...');
      const storage = await page.evaluate(() => JSON.stringify(window.localStorage));
      const match = storage.match(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/);
      if (match) {
        capturedToken = match[0];
      } else {
        const cookies = await context.cookies();
        for (const cookie of cookies) {
          if (cookie.value.startsWith('eyJ') && cookie.value.length > 50) {
            capturedToken = cookie.value;
            break;
          }
        }
      }
    }

    if (capturedToken) {
      fs.writeFileSync(TOKEN_FILE, capturedToken, 'utf8');
      console.log('\n====================================================');
      console.log('✅ SUCCESS: Fresh CoinDCX session token captured!');
      console.log(`✅ Saved to: ${TOKEN_FILE}`);
      console.log('====================================================\n');
    } else {
      await page.screenshot({ path: 'login-final-state.png' });
      console.error('❌ Failed to capture session token. Screenshot saved to login-final-state.png');
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Login error: ${err.message}`);
    try {
      await page.screenshot({ path: 'login-error.png' });
      console.log('Saved debug screenshot to login-error.png');
    } catch {
      // Ignore
    }
    process.exit(1);
  } finally {
    await browser.close();
  }
}

refreshSession();
