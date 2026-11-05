import { readFileSync } from 'node:fs';

/**
 * Sanctions screening of recipient addresses. The default screen checks a committed snapshot of
 * the OFAC SDN Ethereum addresses (refresh with `npm run sanctions:update`). A commercial
 * provider (Chainalysis, TRM, Elliptic) fits behind the same interface.
 */

export interface ScreenResult {
  listed: boolean;
  /** Which list or provider answered, and how fresh it is. */
  source: string;
}

export interface SanctionsScreen {
  check(address: string): Promise<ScreenResult>;
}

interface Snapshot {
  list: string;
  fetchedAt: string;
  addresses: string[];
}

const snapshot = JSON.parse(readFileSync(new URL('../data/sanctions-eth.json', import.meta.url), 'utf8')) as Snapshot;

/** Screens against a fixed set of addresses (the OFAC snapshot by default, plus any extras). */
export function listScreen(extra: string[] = [], base: Snapshot = snapshot): SanctionsScreen {
  const set = new Set([...base.addresses, ...extra].map((a) => a.toLowerCase()));
  const source = `${base.list} (snapshot ${base.fetchedAt.slice(0, 10)}, ${set.size} addresses)`;
  return {
    async check(address) {
      return { listed: set.has(address.toLowerCase()), source };
    },
  };
}

export const sanctionsSnapshot = { list: snapshot.list, fetchedAt: snapshot.fetchedAt, count: snapshot.addresses.length };

/** An address from the snapshot, for tests and the attack lab. */
export const SAMPLE_SANCTIONED_ADDRESS = snapshot.addresses[0]!;
