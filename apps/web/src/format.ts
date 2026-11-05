/**
 * Formats an integer amount in a currency's smallest unit (as a decimal string)
 * without ever going through a float: "1234500000" with 6 decimals → "1,234.50".
 * Trailing fraction zeros are trimmed, but at least `minFraction` digits are kept.
 */
export function formatUnits(raw: string, decimals: number, minFraction = 2): string {
  if (!/^-?\d+$/.test(raw)) throw new Error(`not an integer amount: ${raw}`);
  const negative = raw.startsWith('-');
  const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, '');
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  let fraction = padded.slice(padded.length - decimals);

  const keep = Math.min(minFraction, decimals);
  fraction = fraction.replace(/0+$/, '');
  if (fraction.length < keep) fraction = fraction.padEnd(keep, '0');

  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const isZero = /^0*$/.test(digits);
  return `${negative && !isZero ? '−' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

export function formatDateTime(iso: string): string {
  return dateFormat.format(new Date(iso));
}
