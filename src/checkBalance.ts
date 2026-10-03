import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.COINDCX_API_KEY || '';
const apiSecret = process.env.COINDCX_API_SECRET || '';

const timeStamp = Math.floor(Date.now());
const body = {
  timestamp: timeStamp,
};

const payload = JSON.stringify(body);
const signature = crypto
  .createHmac('sha256', apiSecret)
  .update(payload)
  .digest('hex');

async function checkBalances(): Promise<void> {
  try {
    // 1. Spot Balances
    const spotRes = await fetch('https://api.coindcx.com/exchange/v1/users/balances', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AUTH-APIKEY': apiKey,
        'X-AUTH-SIGNATURE': signature,
      },
      body: payload,
    });

    if (spotRes.ok) {
      const balances = (await spotRes.json()) as Array<{
        currency: string;
        balance: string;
        locked_balance: string;
      }>;
      const nonZero = balances.filter(
        (b) => Number(b.balance) > 0 || Number(b.locked_balance) > 0
      );
      console.log('--- Account Balances ---');
      if (nonZero.length === 0) {
        console.log('No positive balances found (zero balance).');
      } else {
        nonZero.forEach((b) => {
          console.log(`- ${b.currency}: Balance = ${b.balance}, Locked = ${b.locked_balance}`);
        });
      }
    } else {
      console.error(`Failed to fetch balances: HTTP ${spotRes.status}`);
    }

    // 2. Derivatives Wallets
    const dTime = Math.floor(Date.now());
    const dBody = { timestamp: dTime };
    const dPayload = JSON.stringify(dBody);
    const dSig = crypto
      .createHmac('sha256', apiSecret)
      .update(dPayload)
      .digest('hex');

    const derivRes = await fetch('https://api.coindcx.com/exchange/v1/derivatives/futures/wallets', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-AUTH-APIKEY': apiKey,
        'X-AUTH-SIGNATURE': dSig,
      },
    });

    if (derivRes.ok) {
      const derivData = (await derivRes.json()) as unknown;
      console.log('\n--- Derivatives Wallet ---');
      console.log(JSON.stringify(derivData, null, 2));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
  }
}

void checkBalances();
