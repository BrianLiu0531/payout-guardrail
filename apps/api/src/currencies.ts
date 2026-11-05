import type { CurrencyDto } from './dto.js';

/** Display precision per currency. The ledger itself only stores integers in the smallest unit. */
export const CURRENCIES: readonly CurrencyDto[] = [
  { code: 'USDC', decimals: 6 },
  { code: 'EURC', decimals: 6 },
  { code: 'ETH', decimals: 18 },
];
