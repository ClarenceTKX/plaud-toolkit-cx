import { PlaudConfig, PlaudAuth } from '@plaud/core';

/**
 * Verify the credentials already stored in ~/.plaud/ and confirm they
 * authenticate. Supports both auth sources Plaud uses:
 *
 *  - Passkey / browser login (Plaud's official `plaud login`) → ~/.plaud/tokens.json
 *  - Email / password (legacy) → ~/.plaud/config.json
 *
 * This command is intentionally non-interactive: it does not prompt for or
 * overwrite anything. It reads whatever token/credentials exist, verifies them,
 * and reports status. To (re)authenticate with a passkey, run Plaud's official
 * `plaud login`.
 */
export async function loginCommand(_args: string[]): Promise<void> {
  const config = new PlaudConfig();
  const token = config.getToken();
  const creds = config.getCredentials();

  if (!token && !creds) {
    console.error(
      'No Plaud authentication found in ~/.plaud/.\n' +
        'Run Plaud\'s CLI login (`plaud login`) to authenticate — it writes ~/.plaud/tokens.json.',
    );
    process.exit(1);
  }

  const region = config.getRegion();
  console.log(`Verifying Plaud authentication (region: ${region})…`);

  const auth = new PlaudAuth(config);
  try {
    await auth.getToken(); // validates token / logs in if email+password creds exist
  } catch (err: any) {
    console.error(`Verification failed: ${err?.message ?? err}`);
    process.exit(1);
  }

  if (token) {
    const remaining = token.expiresAt - Date.now();
    const days = Math.max(0, Math.floor(remaining / (24 * 60 * 60 * 1000)));
    console.log(`Authenticated (region: ${region}). Token valid for ~${days} day(s).`);
  } else {
    console.log(`Login successful (region: ${region}). Token valid for ~300 days.`);
  }
}
