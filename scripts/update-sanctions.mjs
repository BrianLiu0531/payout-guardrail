// Refreshes packages/core/data/sanctions-eth.json from the OFAC SDN list of Ethereum addresses,
// as extracted by github.com/0xB10C/ofac-sanctioned-digital-currency-addresses (MIT; the
// underlying SDN data is published by the US Treasury). Review the diff before committing.
import { writeFileSync } from 'node:fs';

const SOURCE = 'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt';
const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
const addresses = [...new Set(
  (await res.text())
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => /^0x[0-9a-f]{40}$/.test(l)),
)].sort();
if (addresses.length < 50) throw new Error(`suspiciously short list (${addresses.length}); not writing`);

const out = new URL('../packages/core/data/sanctions-eth.json', import.meta.url);
writeFileSync(out, JSON.stringify({
  list: 'OFAC SDN: Ethereum addresses',
  source: SOURCE,
  fetchedAt: new Date().toISOString(),
  count: addresses.length,
  addresses,
}, null, 2) + '\n');
console.log(`wrote ${addresses.length} addresses`);
