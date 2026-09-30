/**
 * The statistics the Pattern Engine's detectors are built on (PATTERN_ENGINE.md §3):
 * Pearson correlation with its two-tailed p-value, simple linear regression with R², and
 * Welch's t-test.
 *
 * Pure and deterministic — no database, no clock, no randomness, no dependency. Only a
 * handful of primitives are needed, so the Student's t distribution is computed here
 * (through the regularised incomplete beta function) rather than by pulling in a
 * statistics framework.
 *
 * ## What this module does and does not decide
 *
 * It **calculates**. It never decides whether a statistic is strong enough to become a
 * pattern: `n ≥ 10`, `|r| ≥ 0.45`, `R² ≥ 0.3`, `p < 0.10` and the coverage gate belong to the
 * detectors (`PATTERN_ENGINE.md` §3, `PATTERN_ENGINE_DECISIONS.md` D9). The only minimums
 * here are mathematical — the fewest observations for which the statistic is defined.
 *
 * ## Missing data and undefined results
 *
 * - An observation is a finite number. `null`, `undefined`, `NaN` and `±Infinity` are
 *   missing, and for paired statistics the whole pair is dropped. Nothing becomes 0.
 * - When a statistic is undefined — too few observations, or no variance to divide by — the
 *   function returns `null`. It never returns `NaN` or `Infinity`, and never substitutes a
 *   number for a statistic that does not exist.
 * - Paired inputs must be the same length: pairing is by index, and a length mismatch is a
 *   programming error, so it throws.
 */

/** A series as the metric layer produces it: a value, or a gap. */
export type Sample = readonly (number | null | undefined)[];

const isObservation = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** The pairs in which both values are observations, in order. */
function pairs(x: Sample, y: Sample): { xs: number[]; ys: number[] } {
  if (x.length !== y.length) {
    throw new Error(`paired samples must have the same length: ${x.length} vs ${y.length}`);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const a = x[i];
    const b = y[i];
    if (isObservation(a) && isObservation(b)) {
      xs.push(a);
      ys.push(b);
    }
  }
  return { xs, ys };
}

const observations = (sample: Sample): number[] => sample.filter(isObservation);

const mean = (values: readonly number[]): number => {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
};

/**
 * Whether a series varies at all. Compared exactly rather than through a computed variance:
 * the mean of `[0.1, 0.1, 0.1]` is not exactly 0.1 in floating point, so a variance test would
 * call a constant series "slightly variable" and correlate rounding noise.
 */
const varies = (values: readonly number[]): boolean => {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max > min;
};

/** Centred sums of squares and cross-products, two-pass for numerical stability. */
function centredSums(xs: readonly number[], ys: readonly number[]) {
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  return { mx, my, sxx, syy, sxy };
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

// ── Student's t distribution ────────────────────────────────────────────────────

/** ln Γ(z) for z > 0, Lanczos approximation (g = 7, n = 9); ~15 significant digits. */
function logGamma(z: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x = z - 1;
  let sum = c[0]!;
  for (let i = 1; i < 9; i++) sum += c[i]! / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Continued fraction for the incomplete beta function (modified Lentz). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const TINY = 1e-300;
  const EPS = 1e-15;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) return h;
  }
  // Converges in well under 100 iterations for every argument a t-test produces.
  throw new Error('incomplete beta did not converge');
}

/** The regularised incomplete beta function I_x(a, b), for x in [0, 1]. */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  // Use the continued fraction where it converges fast, and the symmetry relation elsewhere.
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * Two-tailed p-value of a Student's t statistic: P(|T| ≥ |t|) with `df` degrees of freedom
 * (df may be fractional, as Welch's is). `null` when df is not positive and finite.
 */
export function studentTTwoTailedP(t: number, df: number): number | null {
  if (!Number.isFinite(df) || df <= 0 || Number.isNaN(t)) return null;
  if (!Number.isFinite(t)) return 0;
  const p = regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
  return clamp(p, 0, 1);
}

// ── Pearson correlation ─────────────────────────────────────────────────────────

export interface CorrelationResult {
  /** Pearson's r, in [−1, 1]. */
  r: number;
  /** Complete pairs used. */
  n: number;
  /** Two-tailed p-value of H0: ρ = 0, from t = r·√((n−2)/(1−r²)), df = n − 2. */
  pValue: number;
}

/** Fewest pairs for which r has a p-value (df = n − 2 ≥ 1). */
export const MIN_CORRELATION_PAIRS = 3;

/**
 * Two-tailed p-value for a correlation `r` over `n` pairs. `null` when n < 3 or r is not a
 * correlation. |r| = 1 gives 0: the t statistic is unbounded.
 */
export function correlationPValue(r: number, n: number): number | null {
  if (!Number.isFinite(r) || Math.abs(r) > 1 || !Number.isInteger(n) || n < MIN_CORRELATION_PAIRS) return null;
  const df = n - 2;
  const rest = 1 - r * r;
  if (rest <= 0) return 0;
  return studentTTwoTailedP(r * Math.sqrt(df / rest), df);
}

/**
 * Pearson's r between two series paired by index, over the pairs where both are observed.
 *
 * `null` when fewer than three pairs remain, or when either series is constant over those
 * pairs — a constant correlates with nothing, and r is 0/0 there, not 0.
 */
export function pearsonCorrelation(x: Sample, y: Sample): CorrelationResult | null {
  const { xs, ys } = pairs(x, y);
  const n = xs.length;
  if (n < MIN_CORRELATION_PAIRS || !varies(xs) || !varies(ys)) return null;

  const { sxx, syy, sxy } = centredSums(xs, ys);
  if (sxx <= 0 || syy <= 0) return null;
  const r = clamp(sxy / Math.sqrt(sxx * syy), -1, 1);
  const pValue = correlationPValue(r, n);
  if (pValue === null) return null;
  return { r, n, pValue };
}

// ── Simple linear regression ────────────────────────────────────────────────────

export interface RegressionResult {
  /** Change in y per unit of x. */
  slope: number;
  intercept: number;
  /**
   * Share of y's variance the line explains, in [0, 1]. `null` when y does not vary: the
   * slope is then exactly 0, but "variance explained" is 0/0 and not a number.
   */
  rSquared: number | null;
  /** Complete pairs used. */
  n: number;
}

/** Fewest pairs for which a fitted line is not a trivial exact fit through two points. */
export const MIN_REGRESSION_PAIRS = 3;

/**
 * Ordinary least squares y = intercept + slope·x over the pairs where both are observed.
 *
 * `null` when fewer than three pairs remain, or when x is constant — every slope fits a
 * vertical cloud equally badly, so none is reported. A constant y is a real, flat line:
 * slope 0, with `rSquared: null`.
 */
export function linearRegression(x: Sample, y: Sample): RegressionResult | null {
  const { xs, ys } = pairs(x, y);
  const n = xs.length;
  if (n < MIN_REGRESSION_PAIRS || !varies(xs)) return null;

  const { mx, my, sxx, syy, sxy } = centredSums(xs, ys);
  if (sxx <= 0) return null;

  if (!varies(ys)) return { slope: 0, intercept: ys[0]!, rSquared: null, n };

  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let residual = 0;
  for (let i = 0; i < n; i++) {
    const e = ys[i]! - (intercept + slope * xs[i]!);
    residual += e * e;
  }
  const rSquared = syy > 0 ? clamp(1 - residual / syy, 0, 1) : null;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
  return { slope, intercept, rSquared, n };
}

// ── Welch's t-test ──────────────────────────────────────────────────────────────

export interface WelchResult {
  /** (mean A − mean B) / standard error. Positive when A's mean is larger. */
  t: number;
  /** Welch–Satterthwaite degrees of freedom; usually fractional. */
  df: number;
  /** Two-tailed p-value of H0: equal means. */
  pValue: number;
  meanA: number;
  meanB: number;
  nA: number;
  nB: number;
}

/** Fewest observations per group for which a sample variance exists. */
export const MIN_WELCH_GROUP = 2;

/** Sample variance (n − 1 denominator); 0 for a constant group. */
function sampleVariance(values: readonly number[], m: number): number {
  if (!varies(values)) return 0;
  let total = 0;
  for (const value of values) total += (value - m) * (value - m);
  return total / (values.length - 1);
}

/**
 * Welch's unequal-variance t-test between two independent groups. Missing values are
 * dropped from each group separately.
 *
 * `null` when either group has fewer than two observations, or when **both** groups are
 * constant: the standard error is then 0 and there is no sampling variation to test against
 * — identical constants are not "p = 1", and different constants are not "p = 0". One
 * constant group is fine; the other's variance carries the test.
 */
export function welchTTest(sampleA: Sample, sampleB: Sample): WelchResult | null {
  const a = observations(sampleA);
  const b = observations(sampleB);
  const nA = a.length;
  const nB = b.length;
  if (nA < MIN_WELCH_GROUP || nB < MIN_WELCH_GROUP) return null;

  const meanA = mean(a);
  const meanB = mean(b);
  const qa = sampleVariance(a, meanA) / nA;
  const qb = sampleVariance(b, meanB) / nB;
  const se2 = qa + qb;
  if (!(se2 > 0)) return null;

  const t = (meanA - meanB) / Math.sqrt(se2);
  const df = (se2 * se2) / ((qa * qa) / (nA - 1) + (qb * qb) / (nB - 1));
  if (!Number.isFinite(t) || !Number.isFinite(df)) return null;
  const pValue = studentTTwoTailedP(t, df);
  if (pValue === null) return null;
  return { t, df, pValue, meanA, meanB, nA, nB };
}
