import { describe, expect, it } from 'vitest';
import { formatUnits } from '../src/format.js';

describe('formatUnits', () => {
  it('formats USDC amounts with grouping and at least two decimals', () => {
    expect(formatUnits('1234500000', 6)).toBe('1,234.50');
    expect(formatUnits('250000000000', 6)).toBe('250,000.00');
    expect(formatUnits('1', 6)).toBe('0.000001');
    expect(formatUnits('0', 6)).toBe('0.00');
  });

  it('trims trailing zeros for 18-decimal amounts', () => {
    expect(formatUnits('21000000000000', 18)).toBe('0.000021');
    expect(formatUnits('500000000000000000', 18)).toBe('0.50');
  });

  it('is exact beyond the range of JavaScript numbers', () => {
    const raw = '123456789012345678901234567890'; // ~1.2e29, far past 2^53
    expect(formatUnits(raw, 18)).toBe('123,456,789,012.345678901234567890'.replace(/0+$/, ''));
    expect(formatUnits('9007199254740993', 0)).toBe('9,007,199,254,740,993'); // 2^53 + 1
  });

  it('handles negatives and zero decimals', () => {
    expect(formatUnits('-1500000', 6)).toBe('−1.50');
    expect(formatUnits('-0', 6)).toBe('0.00');
    expect(formatUnits('42', 0)).toBe('42');
  });

  it('rejects non-integer input instead of guessing', () => {
    expect(() => formatUnits('1.5', 6)).toThrow();
    expect(() => formatUnits('1e6', 6)).toThrow();
  });
});
