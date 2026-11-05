import type pg from 'pg';
import { createPublicClient, erc20Abi, getAddress, http, type Hex, type PublicClient } from 'viem';
import { localChain } from '@guardrail/core';
import type { Ledger } from '@guardrail/ledger';
import { DEMO_ACCOUNTS } from './demo.js';
import { HOT_ETH, HOT_USDC } from './payouts/service.js';
import { migrateAll } from './setup.js';

/** Circle's USDC on Base Sepolia (6 decimals). */
export const BASE_SEPOLIA = { chainId: 84532, rpcUrl: 'https://sepolia.base.org', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Hex };

export interface NetworkSetup {
  rpcUrl: string;
  chainId: number;
  token: Hex;
  /** The signer's address (from `npm run signer:admin -- address`). */
  hotWallet: Hex;
}

export interface NetworkSetupResult {
  token: { symbol: string; decimals: number };
  opening: { usdc: string; eth: string; posted: boolean };
}

/**
 * Install on a real network: chart of accounts, opening balances taken from the chain, and the
 * chain settings. No demo users, no demo history. Idempotent: opening balances are posted once.
 */
export async function setupNetwork(owner: pg.Pool, ledger: Ledger, s: NetworkSetup, client?: PublicClient): Promise<NetworkSetupResult> {
  const chain = client ?? (createPublicClient({ chain: localChain(s.rpcUrl, s.chainId), transport: http(s.rpcUrl) }) as PublicClient);
  const actualChainId = await chain.getChainId();
  if (actualChainId !== s.chainId) throw new Error(`RPC is chain ${actualChainId}, expected ${s.chainId}`);
  const token = getAddress(s.token);
  const hot = getAddress(s.hotWallet);
  const [symbol, decimals, usdc, eth] = await Promise.all([
    chain.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    chain.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    chain.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [hot] }),
    chain.getBalance({ address: hot }),
  ]);
  if (decimals !== 6) throw new Error(`token has ${decimals} decimals; the ledger's USDC accounts expect 6`);

  await migrateAll(owner);
  for (const account of DEMO_ACCOUNTS) await ledger.createAccount(account);

  let posted = false;
  const open = async (key: string, debit: string, credit: string, amount: bigint, what: string) => {
    if (amount === 0n) return;
    const r = await ledger.postTransaction({
      idempotencyKey: key,
      description: `Opening balance: ${what} read from chain ${s.chainId}`,
      metadata: { chainId: s.chainId, address: hot },
      entries: [
        { account: debit, direction: 'debit', amount },
        { account: credit, direction: 'credit', amount },
      ],
    });
    posted ||= !r.replayed;
  };
  // Fixed keys: a second run replays rather than posting again (and refuses if the balance changed).
  await open(`opening:${s.chainId}:${hot}:usdc`, HOT_USDC, 'equity:owner-capital:usdc', usdc, `${symbol} in the hot wallet`).catch(ignoreReplayConflict);
  await open(`opening:${s.chainId}:${hot}:eth`, HOT_ETH, 'equity:owner-capital:eth', eth, 'ETH in the hot wallet').catch(ignoreReplayConflict);

  for (const [k, v] of [['token', token], ['hot_wallet', hot], ['chain_id', String(s.chainId)]] as const) {
    await owner.query('INSERT INTO payouts.config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
  }
  return { token: { symbol, decimals }, opening: { usdc: usdc.toString(), eth: eth.toString(), posted } };
}

/** A later run sees a different chain balance under the same key: the opening entry already exists, which is fine. */
function ignoreReplayConflict(err: unknown): void {
  if ((err as { code?: string }).code !== 'IDEMPOTENCY_CONFLICT') throw err;
}
