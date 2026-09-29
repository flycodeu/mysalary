import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney } from '../src/domain/money';

describe('money is parsed as exact integer fen', () => {
  it.each([
    ['14138.2', 1413820], ['-204.8', -20480], ['0.01', 1], ['+0.10', 10],
    ['￥１，２３４．５０', 123450], ['−204.80元', -20480], [' -0.00 ', 0],
    ['90,071,992,547,409.91', Number.MAX_SAFE_INTEGER],
  ])('parses %s', (text, expected) => expect(parseMoney(text)).toBe(expected));

  it.each(['', '12,34', '1 234', '12.345', '1e3', 'NaN', 'Infinity', '100.', '.12', '221O',
    '--20', '90,071,992,547,409.92', '-90,071,992,547,409.92', '121.20.30'])('does not guess %s', (text) => {
    expect(parseMoney(text)).toBeNull();
  });

  it('formats safe integer digits without rounding large values', () => {
    expect(formatMoney(Number.MAX_SAFE_INTEGER)).toBe('90,071,992,547,409.91');
    expect(formatMoney(-20480)).toBe('-204.80');
    expect(formatMoney(1)).toBe('0.01');
    expect(formatMoney(null)).toBe('—');
    expect(() => formatMoney(1.5)).toThrow(RangeError);
  });
});
