import dotenv from 'dotenv';
import { loadConfig, TRUST_SENSITIVE_ENV_KEYS, sanitizeTrustSensitiveEnv } from './config.js';
import { HoppscotchMCPServer } from './server.js';

// CLI entry point. This file owns the process lifecycle (env loading, signal
// handling, and exit codes) so the server class (src/server.ts) stays free of
// process-lifecycle side effects (no argv, signals, or exit) and remains
// unit-testable in-process.

// quiet:true suppresses dotenv's startup banner: on a stdio MCP server any
// stray stdout write corrupts the JSON-RPC frame. (dotenv >= 16.6 is quiet by
// default; the option keeps older 16.5.x resolutions safe too.)
//
// By default a working-directory .env is honoured in full (backwards-compatible).
// Operators who run this server in editors that may open untrusted repos can opt
// in to strict mode with HOPPSCOTCH_STRICT_ENV=true: trust-sensitive vars that a
// .env INTRODUCES (were absent from the real environment) are then stripped, so a
// hostile repo .env can't disable the SSRF guard, repoint the auth target, or
// allowlist a secret-exfiltration origin. The flag is read from the REAL
// environment before dotenv, so a .env cannot toggle it.
const strictEnv = process.env.HOPPSCOTCH_STRICT_ENV === 'true';
const ambientTrustEnv = Object.fromEntries(
  TRUST_SENSITIVE_ENV_KEYS.map((key) => [key, process.env[key]])
);
dotenv.config({ quiet: true });
if (strictEnv) {
  const strippedEnv = sanitizeTrustSensitiveEnv(ambientTrustEnv);
  if (strippedEnv.length > 0) {
    console.error(
      `[MCP] HOPPSCOTCH_STRICT_ENV: ignored ${strippedEnv.join(', ')} introduced by .env — ` +
        `these are operator-only and must be set in the real environment.`
    );
  }
}

// Last-resort safety net: an unhandled rejection or thrown error must never
// escape silently or print to stdout (the JSON-RPC channel). Log to stderr and
// exit non-zero so the host sees a clean failure instead of a corrupted stream.
process.on('unhandledRejection', (reason) => {
  console.error('[MCP] Unhandled promise rejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[MCP] Uncaught exception:', err);
  process.exit(1);
});

async function main() {
  try {
    const server = new HoppscotchMCPServer(loadConfig());

    // Graceful shutdown on SIGINT (Ctrl-C) and SIGTERM (process managers,
    // containers, npx-parent kill): close the transport cleanly, then exit.
    const shutdown = async () => {
      try {
        await server.close();
      } finally {
        process.exit(0);
      }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await server.run();
  } catch (error) {
    if (error instanceof Error) {
      console.error('Failed to start Hoppscotch MCP Server:', error.message);
    } else {
      console.error('Failed to start Hoppscotch MCP Server:', error);
    }
    process.exit(1);
  }
}

main();
