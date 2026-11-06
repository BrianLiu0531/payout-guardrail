import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type pg from 'pg';
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { localChain, mockUsdcAbi, mockUsdcBytecode, payoutVaultAbi, payoutVaultBytecode, SoftAuthenticator } from '@guardrail/core';
import { migrate, type Ledger } from '@guardrail/ledger';
import { Signer } from '@guardrail/signer';
import { seedDemo } from './demo.js';
import { migratePayouts, HOT_ETH, HOT_USDC, type ChainSettings } from './payouts/service.js';

export const DEMO_USERS = [
  { id: 'alice', name: 'Alice Chen', role: 'requester' },
  { id: 'bob', name: 'Bob Martin', role: 'approver' },
  { id: 'carol', name: 'Carol Diaz', role: 'approver' },
] as const;

export const DEMO_PAYEES = [
  // Anvil accounts #3 and #4: well-known local addresses.
  { id: 'acme-hosting', name: 'Acme Hosting', address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' },
  { id: 'northwind-contractors', name: 'Northwind Contractors', address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' },
] as const;

const BOOTSTRAP_AT = new Date('2026-10-20T00:00:00Z');

/** On-chain cap on what the hot key can pay out of the vault per day (demo value). */
export const DEMO_VAULT_DAILY_LIMIT = 10_000n * 1_000_000n;

export async function migrateAll(pool: pg.Pool): Promise<void> {
  await migrate(pool);
  await migratePayouts(pool);
  await Signer.migrate(pool);
}

export async function readChainSettings(pool: pg.Pool): Promise<ChainSettings | null> {
  const { rows } = await pool.query<{ key: string; value: string }>('SELECT key, value FROM payouts.config');
  const m = new Map(rows.map((r) => [r.key, r.value]));
  if (!m.has('token') || !m.has('hot_wallet') || !m.has('chain_id')) return null;
  const hotWallet = m.get('hot_wallet') as Hex;
  return { token: m.get('token') as Hex, hotWallet, custody: (m.get('vault') ?? hotWallet) as Hex, chainId: Number(m.get('chain_id')) };
}

export interface SeedOptions {
  rpcUrl: string;
  chainId: number;
  hotKey: Hex;
  deployerKey: Hex;
  keysFile: string;
  webauthn: { rpId: string; origins: string[] };
  /** Payees: defaults to the demo payees. */
  payees?: readonly { id: string; name: string; address: string }[];
}

/**
 * Demo install: ledger history, a token on the local chain holding exactly what the ledger
 * says the hot wallet has, demo users with software passkeys, payees, and the signer's
 * bootstrap. Idempotent.
 */
export async function seedAll(pool: pg.Pool, ledger: Ledger, opts: SeedOptions): Promise<{ chain: ChainSettings; bots: Map<string, SoftAuthenticator> }> {
  await migrateAll(pool);
  await seedDemo(ledger);

  const chainDef = localChain(opts.rpcUrl, opts.chainId);
  const publicClient = createPublicClient({ chain: chainDef, transport: http(opts.rpcUrl) }) as PublicClient;
  const hot = privateKeyToAccount(opts.hotKey);

  // ---- token and balances ----
  let settings = await readChainSettings(pool);
  const code = settings ? await publicClient.getCode({ address: settings.token }) : undefined;
  if (!settings || !code || code === '0x') {
    const deployer = createWalletClient({ chain: chainDef, transport: http(opts.rpcUrl), account: privateKeyToAccount(opts.deployerKey) });
    const hash = await deployer.deployContract({ abi: mockUsdcAbi, bytecode: mockUsdcBytecode });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const token = getAddress(receipt.contractAddress as Hex);
    // The float sits in a PayoutVault: the hot key can only pay out of it within a daily limit.
    // The deployer stands in for the vault's owner, which in production is a multisig.
    const vaultHash = await deployer.deployContract({
      abi: payoutVaultAbi, bytecode: payoutVaultBytecode, args: [token, deployer.account.address, hot.address, DEMO_VAULT_DAILY_LIMIT],
    });
    const vault = getAddress((await publicClient.waitForTransactionReceipt({ hash: vaultHash })).contractAddress as Hex);
    const usdc = (await ledger.getBalance(HOT_USDC)).balance;
    const mint = await deployer.writeContract({ address: token, abi: mockUsdcAbi, functionName: 'mint', args: [vault, usdc] });
    await publicClient.waitForTransactionReceipt({ hash: mint });
    const eth = (await ledger.getBalance(HOT_ETH)).balance;
    await createTestClient({ chain: chainDef, mode: 'anvil', transport: http(opts.rpcUrl) }).setBalance({ address: hot.address, value: eth });
    settings = { token, hotWallet: hot.address, custody: vault, chainId: opts.chainId };
    // Transfers into custody from the next block on are deposits the indexer must report.
    const fromBlock = String((await publicClient.getBlockNumber()) + 1n);
    for (const [k, v] of [['token', token], ['hot_wallet', hot.address], ['vault', vault], ['chain_id', String(opts.chainId)], ['deposits_from_block', fromBlock]]) {
      await pool.query('INSERT INTO payouts.config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
    }
  }

  // ---- demo users and their software passkeys ----
  let keys: Record<string, { credentialId: string; privateKeyPkcs8: string }> = {};
  if (existsSync(opts.keysFile)) keys = JSON.parse(await readFile(opts.keysFile, 'utf8'));
  const bots = new Map<string, SoftAuthenticator>();
  for (const u of DEMO_USERS) {
    await pool.query('INSERT INTO payouts.users (id, name, role, demo) VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING', [u.id, u.name, u.role]);
    if (u.role !== 'approver') continue;
    const key = keys[u.id] ? SoftAuthenticator.fromJSON(keys[u.id]!) : SoftAuthenticator.create();
    keys[u.id] = key.toJSON();
    bots.set(u.id, key);
    await pool.query(
      `INSERT INTO payouts.credentials (id, user_id, public_key, transports, software, enrolled) VALUES ($1, $2, $3, '{internal}', true, true)
       ON CONFLICT DO NOTHING`,
      [key.credentialId, u.id, Buffer.from(key.publicKeyCose())],
    );
  }
  await writeFile(opts.keysFile, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });

  // ---- payees ----
  const payees = opts.payees ?? DEMO_PAYEES;
  for (const p of payees) {
    await pool.query(
      `INSERT INTO payouts.payees (id, name, address, chain_id, status, activated_at, created_at) VALUES ($1, $2, $3, $4, 'active', $5, $5)
       ON CONFLICT DO NOTHING`,
      [p.id, p.name, getAddress(p.address), opts.chainId, BOOTSTRAP_AT],
    );
  }

  // ---- the signer's own records (done on the signer host at install time) ----
  const signer = new Signer({ pool, account: hot, chain: publicClient, webauthn: opts.webauthn });
  await signer.bootstrap({
    chainId: opts.chainId,
    token: settings.token,
    vault: settings.custody !== settings.hotWallet ? settings.custody : undefined,
    approvers: [...bots].map(([userId, k]) => ({ userId, credentialId: k.credentialId, publicKey: k.publicKeyCose() })),
    payees: payees.map((p) => ({ payeeId: p.id, name: p.name, address: getAddress(p.address), chainId: opts.chainId, activatedAt: BOOTSTRAP_AT })),
  });

  return { chain: settings, bots };
}
