import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';

/** Anvil's well-known account #1, the demo hot wallet. Public: local chain only. */
export const ANVIL_HOT_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
/** Anvil's well-known account #0, used to deploy the demo token. */
export const ANVIL_DEPLOYER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export function apiConfig(env: NodeJS.ProcessEnv = process.env) {
  const chainId = Number(env.CHAIN_ID ?? 31337);
  const demoMode = env.DEMO_MODE !== 'false';
  if (demoMode && chainId !== 31337) throw new Error('DEMO_MODE is only allowed on the local chain (CHAIN_ID=31337)');
  const ownerUrl = env.DATABASE_URL ?? 'postgres://guardrail:guardrail@localhost:5434/guardrail';
  const rolePasswords = {
    api: env.API_DB_PASSWORD ?? 'guardrail_api_dev',
    signer: env.SIGNER_DB_PASSWORD ?? 'guardrail_signer_dev',
  };
  const withUser = (user: string, password: string) => {
    const u = new URL(ownerUrl);
    u.username = user;
    u.password = password;
    return u.toString();
  };
  return {
    /** Owner: migrations, role grants, seeding. Never used for request handling. */
    databaseUrl: ownerUrl,
    /** What the API runs as: least privilege, no access to the signer's schema. */
    apiDatabaseUrl: env.API_DATABASE_URL ?? withUser('guardrail_api', rolePasswords.api),
    rolePasswords,
    port: Number(env.PORT ?? 8787),
    // Loopback by default. Put a TLS-terminating proxy in front before exposing it.
    host: env.HOST ?? '127.0.0.1',
    signerUrl: env.SIGNER_URL ?? 'http://127.0.0.1:8788',
    signerToken: env.SIGNER_TOKEN ?? 'dev-signer-token',
    rpcUrl: env.CHAIN_RPC_URL ?? 'http://127.0.0.1:8545',
    chainId,
    confirmations: Number(env.CONFIRMATIONS ?? 1),
    demoMode,
    demoKeysFile: env.DEMO_KEYS_FILE ?? fileURLToPath(new URL('../../../.demo-keys.json', import.meta.url)),
    leakedKey: (env.SIGNER_PRIVATE_KEY ?? ANVIL_HOT_KEY) as Hex,
    secureCookies: env.SECURE_COOKIES === 'true',
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 1000),
    reconIntervalMs: Number(env.RECON_INTERVAL_MS ?? 15000),
    webauthn: {
      rpId: env.WEBAUTHN_RP_ID ?? 'localhost',
      rpName: 'Payout Guardrail',
      origins: (env.WEBAUTHN_ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(','),
    },
  };
}

export type ApiConfig = ReturnType<typeof apiConfig>;
