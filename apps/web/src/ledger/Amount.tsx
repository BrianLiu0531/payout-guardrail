import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { formatUnits } from '../format.js';

export function useDecimals(): (currency: string) => number | undefined {
  const { data } = useQuery({ queryKey: ['currencies'], queryFn: ({ signal }) => api.currencies(signal), staleTime: Infinity });
  const map = new Map(data?.currencies.map((c) => [c.code, c.decimals]));
  return (currency) => map.get(currency);
}

interface AmountProps {
  raw: string;
  currency: string;
  /** Show the currency code after the number. */
  showCurrency?: boolean;
}

/** An exact amount: formatted from the integer string, never via floating point. */
export function Amount({ raw, currency, showCurrency = true }: AmountProps) {
  const decimals = useDecimals()(currency);
  const text = decimals === undefined ? raw : formatUnits(raw, decimals);
  const negative = raw.startsWith('-') && !/^-0*$/.test(raw);
  return (
    <span className={negative ? 'amount negative' : 'amount'} title={`${raw} (smallest unit)`}>
      {text}
      {showCurrency && <span className="currency"> {currency}</span>}
    </span>
  );
}
