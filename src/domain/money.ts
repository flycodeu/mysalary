/** Normalize typography, without guessing missing digits or decimal points. */
export function normalizeMoneyText(text: string): string {
  return text
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10))
    .replace(/[．]/g, '.')
    .replace(/[，]/g, ',')
    .replace(/[−﹣－]/g, '-')
    .replace(/[＋]/g, '+')
    .trim();
}

/** Parse CNY as integer fen. Invalid or ambiguous input remains unknown. */
export function parseMoney(text: string): number | null {
  const normalized = normalizeMoneyText(text)
    .replace(/^([+-]?)\s*[¥￥]\s*/, '$1')
    .replace(/\s*元$/, '')
    .trim();
  const match = /^([+-]?)(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;

  const integer = match[2]!.replaceAll(',', '');
  const fraction = (match[3] ?? '').padEnd(2, '0');
  const absolute = BigInt(integer) * 100n + BigInt(fraction);
  const minor = match[1] === '-' ? -absolute : absolute;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < BigInt(Number.MIN_SAFE_INTEGER)) {
    return null;
  }
  return Number(minor);
}

/** Formatting uses the integer digits directly, including near the safe limit. */
export function formatMoney(minor: number | null): string {
  if (minor === null) return '—';
  if (!Number.isSafeInteger(minor)) throw new RangeError('金额必须是安全整数分');
  const digits = Math.abs(minor).toString().padStart(3, '0');
  const integer = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${minor < 0 ? '-' : ''}${integer}.${digits.slice(-2)}`;
}
