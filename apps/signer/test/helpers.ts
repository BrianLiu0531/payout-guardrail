import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, parseEther, type Hex, type PublicClient, type WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { localChain, mockUsdcAbi, mockUsdcBytecode, payoutVaultAbi, payoutVaultBytecode } from '@guardrail/core';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://guardrail:guardrail@localhost:5434/guardrail';
export const RPC_URL = process.env.CHAIN_RPC_URL ?? 'http://127.0.0.1:8545';
export const chain = localChain(RPC_URL);

/** A fresh empty database, dropped afterwards. Callers run whichever migrations they need. */
export async function freshDb(): Promise<{ pool: pg.Pool; url: string; drop(): Promise<void> }> {
  const name = `guardrail_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 20 });
  return {
    pool,
    url: url.toString(),
    async drop() {
      await pool.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export interface TestChain {
  publicClient: PublicClient;
  hot: PrivateKeyAccount;
  token: Hex;
  mint(to: Hex, amount: bigint): Promise<void>;
  balanceOf(who: Hex): Promise<bigint>;
  /** Deploys a PayoutVault owned by the deployer, with the hot wallet as its signer. */
  deployVault(dailyLimit: bigint): Promise<Hex>;
  /** The deployer, standing in for the vault owner (a multisig in production). */
  owner: WalletClient;
}

/**
 * A fresh hot wallet (random key, funded with gas) and a freshly deployed MockUSDC, so test
 * files running in parallel on one anvil never share nonces or balances.
 */
export async function freshChain(): Promise<TestChain> {
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) }) as PublicClient;
  const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC_URL) });
  const deployer = privateKeyToAccount(generatePrivateKey());
  const hot = privateKeyToAccount(generatePrivateKey());
  await test.setBalance({ address: deployer.address, value: parseEther('10') });
  await test.setBalance({ address: hot.address, value: parseEther('1') });
  const wallet = createWalletClient({ chain, transport: http(RPC_URL), account: deployer });
  const deployHash = await wallet.deployContract({ abi: mockUsdcAbi, bytecode: mockUsdcBytecode });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const token = getAddress(receipt.contractAddress as Hex);
  return {
    publicClient,
    hot,
    token,
    async mint(to, amount) {
      const h = await wallet.writeContract({ address: token, abi: mockUsdcAbi, functionName: 'mint', args: [to, amount] });
      await publicClient.waitForTransactionReceipt({ hash: h });
    },
    balanceOf: (who) => publicClient.readContract({ address: token, abi: mockUsdcAbi, functionName: 'balanceOf', args: [who] }),
    owner: wallet,
    async deployVault(dailyLimit) {
      const h = await wallet.deployContract({ abi: payoutVaultAbi, bytecode: payoutVaultBytecode, args: [token, deployer.address, hot.address, dailyLimit] });
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      return getAddress(r.contractAddress as Hex);
    },
  };
}

export const randomAddress = (): Hex => privateKeyToAccount(generatePrivateKey()).address;
