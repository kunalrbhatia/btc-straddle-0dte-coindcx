import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.COINDCX_API_KEY || '';
const apiSecret = process.env.COINDCX_API_SECRET || '';

if (!apiKey || !apiSecret) {
  console.error('❌ COINDCX_API_KEY or COINDCX_API_SECRET is missing in .env!');
  process.exit(1);
}

const maskedKey = apiKey.slice(0, 4) + '...' + apiKey.slice(-4);
console.log(`[Auth Test] Testing API Key: ${maskedKey}`);

const timeStamp = Math.floor(Date.now());
const body = {
  timestamp: timeStamp,
};

const payload = JSON.stringify(body);
const signature = crypto
  .createHmac('sha256', apiSecret)
  .update(payload)
  .digest('hex');

async function testConnection(): Promise<void> {
  try {
    const response = await fetch('https://api.coindcx.com/exchange/v1/users/info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AUTH-APIKEY': apiKey,
        'X-AUTH-SIGNATURE': signature,
      },
      body: payload,
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (response.ok) {
      console.log('✅ API Authentication SUCCESSFUL!');
      console.log(`   Account Email: ${data.email || 'N/A'}`);
      console.log(`   Trade Enabled: ${data.trade_enabled !== false ? 'YES' : 'NO'}`);
      console.log(`   Status: Active\n`);
    } else {
      console.error(`❌ Authentication FAILED: HTTP ${response.status}`);
      console.error(`   Message: ${data.message || JSON.stringify(data)}\n`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Network error connecting to CoinDCX: ${msg}`);
  }
}

void testConnection();
