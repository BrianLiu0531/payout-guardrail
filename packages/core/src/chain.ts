import { defineChain, encodeFunctionData, parseAbiItem, type Hex } from 'viem';
import { mockUsdcAbi } from './mockUsdc.js';

export { mockUsdcAbi, mockUsdcBytecode } from './mockUsdc.js';

/** Local anvil chain used by the demo and the tests. */
export function localChain(rpcUrl: string, chainId = 31337) {
  return defineChain({
    id: chainId,
    name: 'Anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export function encodeTransfer(to: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: mockUsdcAbi, functionName: 'transfer', args: [to, amount] });
}

/** Gas limit for an ERC-20 transfer, with headroom. Fixed so the signer never asks the API. */
export const TRANSFER_GAS = 90_000n;
