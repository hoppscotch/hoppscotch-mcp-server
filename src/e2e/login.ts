/**
 * One-shot login helper for e2e tests.
 * Runs the device-login flow, stores the token, and exits.
 * Run: npx tsx src/e2e/login.ts
 */
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

import { loadConfig } from '../config.js';
import { getValidToken } from '../auth.js';

const config = loadConfig();
console.log(`Logging in to ${config.serverUrl} ...`);
const token = await getValidToken(config.serverUrl, config.apiUrl, config.apiType, config.accessToken);
console.log(`\nLogin successful. Token stored at ~/.config/hoppscotch-mcp/auth.json`);
console.log(`Token preview: ${token.slice(0, 20)}...`);
console.log(`\nNow run: HOPPSCOTCH_E2E=1 npm run test:e2e`);
process.exit(0);
