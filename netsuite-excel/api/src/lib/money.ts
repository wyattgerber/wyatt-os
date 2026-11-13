// Exact money math. Amounts are held as BigInt micro-units (1e-6). Never use floats for sums.

const SCALE = 6;
const FACTOR = 10n ** BigInt(SCALE);

/**
 * Parse a NetSuite amount (string or number or null) to micro-units. Throws on anything unexpected (fail closed).
 * Accepts scientific notation ("3.572068025E7"), which NetSuite has been seen to return, exactly (no floats).
 * Throws if the value has more than 6 decimal places.
 */
export function parseMoney(v: unknown): bigint {
  if (v === null || v === undefined || v === '') return 0n;
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Non-finite money value');
    s = String(v);
  } else if (typeof v === 'string') {
    s = v.trim();
  } else {
    throw new Error('Unexpected money value type');
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) throw new Error('Unparseable money value');
  const fracDigits = m[3] ?? '';
  const exp = m[4] === undefined ? 0 : Number(m[4]);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 40) throw new Error('Unreasonable money exponent');
  const digits = BigInt(m[2] + fracDigits);
  const shift = SCALE + exp - fracDigits.length; // value * 10^SCALE = digits * 10^shift
  let n: bigint;
  if (shift >= 0) {
    n = digits * 10n ** BigInt(shift);
  } else {
    const div = 10n ** BigInt(-shift);
    if (digits % div !== 0n) throw new Error('Money value has more than 6 decimal places');
    n = digits / div;
  }
  return m[1] === '-' ? -n : n;
}

/** Micro-units to a decimal string with at least 2 decimals (more only if non-zero). */
export function formatMoney(n: bigint): string {
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / FACTOR;
  let frac = (abs % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}
