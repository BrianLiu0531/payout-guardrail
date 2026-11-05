/**
 * API host administration (runs as the database owner).
 *
 *   npm run admin -- network-setup        chart of accounts, opening balances from chain, chain settings
 *                                         (CHAIN_ID, CHAIN_RPC_URL, TOKEN_ADDRESS, HOT_WALLET)
 *   npm run admin -- pending-approvers    passkeys registered but not yet enrolled in the signer
 *   npm run admin -- set-role <userId> <requester|approver|admin>
 */
import pg from 'pg';
import { Ledger } from '@guardrail/ledger';
import type { Hex } from 'viem';
import { apiConfig } from './config.js';
import { BASE_SEPOLIA, setupNetwork } from './network.js';
import { applyRoles } from './roles.js';

const [command, ...args] = process.argv.slice(2);
const cfg = apiConfig();
const owner = new pg.Pool({ connectionString: cfg.databaseUrl, max: 3 });
try {
  switch (command) {
    case 'network-setup': {
      const token = (process.env.TOKEN_ADDRESS ?? (cfg.chainId === BASE_SEPOLIA.chainId ? BASE_SEPOLIA.usdc : undefined)) as Hex | undefined;
      const hotWallet = process.env.HOT_WALLET as Hex | undefined;
      if (!token || !hotWallet) throw new Error('set TOKEN_ADDRESS and HOT_WALLET (from `npm run signer:admin -- address`)');
      const result = await setupNetwork(owner, new Ledger(owner), { rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, token, hotWallet });
      await applyRoles(owner, cfg.rolePasswords);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'network-check': {
      // Read-only: is the RPC the expected chain, is the token what we think, what does the hot wallet hold?
      const { createPublicClient, erc20Abi, formatEther, formatUnits, http } = await import('viem');
      const client = createPublicClient({ transport: http(cfg.rpcUrl) });
      const token = (process.env.TOKEN_ADDRESS ?? (cfg.chainId === BASE_SEPOLIA.chainId ? BASE_SEPOLIA.usdc : undefined)) as Hex | undefined;
      const chainId = await client.getChainId();
      console.log(`RPC ${cfg.rpcUrl}: chain ${chainId}${chainId === cfg.chainId ? '' : ` (expected ${cfg.chainId}!)`}, block ${await client.getBlockNumber()}`);
      if (token) {
        const [symbol, decimals] = await Promise.all([
          client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
          client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
        ]);
        console.log(`token ${token}: ${symbol}, ${decimals} decimals`);
        const hot = process.env.HOT_WALLET as Hex | undefined;
        if (hot) {
          const [bal, eth] = await Promise.all([
            client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [hot] }),
            client.getBalance({ address: hot }),
          ]);
          console.log(`hot wallet ${hot}: ${formatUnits(bal, decimals)} ${symbol}, ${formatEther(eth)} ETH`);
          if (eth === 0n || bal === 0n) console.log('fund it from a faucet (ETH for gas, and test USDC from https://faucet.circle.com) before running payouts');
        }
      }
      break;
    }
    case 'pending-approvers': {
      const { rows } = await owner.query(
        `SELECT c.user_id, c.id, encode(c.public_key, 'base64') AS pk FROM payouts.credentials c WHERE NOT c.enrolled AND NOT c.software ORDER BY c.created_at`,
      );
      for (const r of rows) {
        const pk = Buffer.from(r.pk, 'base64').toString('base64url');
        console.log(`npm run signer:admin -- enroll ${r.user_id} ${r.id} ${pk}`);
      }
      if (rows.length === 0) console.log('no passkeys waiting');
      break;
    }
    case 'set-role': {
      const [userId, role] = args;
      if (!userId || !['requester', 'approver', 'admin'].includes(role ?? '')) throw new Error('usage: set-role <userId> <requester|approver|admin>');
      const r = await owner.query('UPDATE payouts.users SET role = $2 WHERE id = $1', [userId, role]);
      console.log(r.rowCount === 1 ? `${userId} is now ${role}` : `no user ${userId}`);
      break;
    }
    default:
      throw new Error('commands: network-setup | pending-approvers | set-role <userId> <role>');
  }
} finally {
  await owner.end();
}
