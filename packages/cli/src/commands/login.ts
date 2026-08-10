import * as readline from 'readline';
import { PlaudConfig, PlaudAuth } from '@plaud/core';

export async function loginCommand(_args: string[]): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  try {
    const email = await ask('Plaud email: ');
    const password = await ask('Password: ');

    const config = new PlaudConfig();
    // Region is auto-detected during login — default to 'eu' and let PlaudAuth
    // fall back to the correct region, persisting whichever one works.
    config.saveCredentials({ email: email.trim(), password, region: 'eu' });

    console.log('Credentials saved. Verifying (auto-detecting region)…');

    const auth = new PlaudAuth(config);
    await auth.login();
    const region = config.getCredentials()?.region ?? 'eu';
    console.log(`Login successful (region: ${region}). Token valid for ~300 days.`);
  } finally {
    rl.close();
  }
}
