// Exact money math. Amounts are held as BigInt micro-units (1e-6). Never use floats for sums.

const SCALE = 6;
const FACTOR = 10n ** BigInt(SCALE);

/** Parse a NetSuite amount (string or number or null) to micro-units. Throws on anything unexpected (fail closed). */
export function parseMoney(v: unknown): bigint {
  if (v === null || v === undefined || v === '') return 0n;
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Non-finite money value');
    s = String(v);
    if (/e/i.test(s)) s = v.toFixed(SCALE);
  } else if (typeof v === 'string') {
    s = v.trim();
  } else {
    throw new Error('Unexpected money value type');
  }
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error('Unparseable money value');
  const frac = (m[3] ?? '').padEnd(SCALE, '0');
  const n = BigInt(m[2]) * FACTOR + BigInt(frac);
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
