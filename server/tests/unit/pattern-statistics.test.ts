import { describe, expect, it } from 'vitest';
import {
  MIN_CORRELATION_PAIRS,
  MIN_REGRESSION_PAIRS,
  MIN_WELCH_GROUP,
  correlationPValue,
  linearRegression,
  pearsonCorrelation,
  studentTTwoTailedP,
  welchTTest,
  type Sample,
} from '../../src/patterns/statistics.js';

/**
 * The Pattern Engine's statistical primitives, pinned against closed forms, published
 * reference values and hand-computable data. Tolerances are for floating point, not slack:
 * each is far tighter than any gate a detector will apply.
 */

/** Every number in a result is finite — nothing NaN or infinite leaks out. */
const allFinite = (result: object): boolean =>
  Object.values(result).every((value) => value === null || (typeof value === 'number' && Number.isFinite(value)));

describe('studentTTwoTailedP', () => {
  it('matches the closed forms for 1, 2 and 3 degrees of freedom', () => {
    for (const t of [0.1, 0.4, 1, 2.5, 6.3, 40]) {
      // df = 1 (Cauchy): 1 − (2/π)·atan|t|
      expect(studentTTwoTailedP(t, 1)!).toBeCloseTo(1 - (2 / Math.PI) * Math.atan(t), 12);
      // df = 2: 1 − |t| / √(2 + t²)
      expect(studentTTwoTailedP(t, 2)!).toBeCloseTo(1 - t / Math.sqrt(2 + t * t), 12);
      // df = 3: 1 − (2/π)·(atan u + u / (1 + u²)), u = |t|/√3
      const u = t / Math.sqrt(3);
      expect(studentTTwoTailedP(t, 3)!).toBeCloseTo(1 - (2 / Math.PI) * (Math.atan(u) + u / (1 + u * u)), 12);
    }
  });

  it('reproduces tabulated critical values', () => {
    expect(studentTTwoTailedP(12.706204736, 1)!).toBeCloseTo(0.05, 8);
    expect(studentTTwoTailedP(2.228138852, 10)!).toBeCloseTo(0.05, 8);
    expect(studentTTwoTailedP(1.782287556, 12)!).toBeCloseTo(0.1, 8);
    expect(studentTTwoTailedP(2.048407142, 28)!).toBeCloseTo(0.05, 8);
    // Approaches the normal distribution for large df.
    expect(studentTTwoTailedP(1.959963985, 1e7)!).toBeCloseTo(0.05, 5);
  });

  it('is symmetric in t, 1 at t = 0, and 0 for an unbounded t', () => {
    expect(studentTTwoTailedP(-2.5, 9)).toBe(studentTTwoTailedP(2.5, 9));
    expect(studentTTwoTailedP(0, 9)).toBe(1);
    expect(studentTTwoTailedP(Infinity, 9)).toBe(0);
  });

  it('accepts fractional degrees of freedom, as Welch produces', () => {
    const p = studentTTwoTailedP(2, 7.5)!;
    expect(p).toBeGreaterThan(studentTTwoTailedP(2, 8)!);
    expect(p).toBeLessThan(studentTTwoTailedP(2, 7)!);
  });

  it('returns null rather than a number when df is not usable', () => {
    expect(studentTTwoTailedP(2, 0)).toBeNull();
    expect(studentTTwoTailedP(2, -3)).toBeNull();
    expect(studentTTwoTailedP(2, NaN)).toBeNull();
    expect(studentTTwoTailedP(2, Infinity)).toBeNull();
    expect(studentTTwoTailedP(NaN, 5)).toBeNull();
  });

  it('stays in [0, 1] and finite across a wide range', () => {
    for (const df of [1, 1.5, 3, 10, 29, 120, 1e4]) {
      for (const t of [0, 1e-9, 0.5, 2, 10, 1e3, 1e8]) {
        const p = studentTTwoTailedP(t, df)!;
        expect(Number.isFinite(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('pearsonCorrelation', () => {
  it('is 1 for a perfect positive relationship, with p = 0', () => {
    expect(pearsonCorrelation([1, 2, 3, 4, 5], [3, 5, 7, 9, 11])).toEqual({ r: 1, n: 5, pValue: 0 });
  });

  it('is −1 for a perfect negative relationship', () => {
    const result = pearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])!;
    expect(result.r).toBe(-1);
    expect(result.pValue).toBe(0);
  });

  it('computes a textbook r and its p-value', () => {
    // r = √0.6; t = r·√(3/(1 − r²)), df = 3, checked against the closed form above.
    const result = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])!;
    expect(result.r).toBeCloseTo(Math.sqrt(0.6), 12);
    expect(result.n).toBe(5);
    const u = (Math.sqrt(0.6) * Math.sqrt(3 / 0.4)) / Math.sqrt(3);
    expect(result.pValue).toBeCloseTo(1 - (2 / Math.PI) * (Math.atan(u) + u / (1 + u * u)), 12);
  });

  it('is 0 with p = 1 for an uncorrelated series', () => {
    const result = pearsonCorrelation([1, 2, 3, 4, 5], [2, 1, 0, 1, 2])!;
    expect(result.r).toBeCloseTo(0, 12);
    expect(result.pValue).toBeCloseTo(1, 12);
  });

  it('is invariant to scale and shift, and symmetric in its arguments', () => {
    const x = [3, 7, 1, 9, 4, 6];
    const y = [2, 8, 3, 7, 5, 4];
    const base = pearsonCorrelation(x, y)!;
    expect(pearsonCorrelation(y, x)!.r).toBeCloseTo(base.r, 14);
    expect(pearsonCorrelation(x.map((v) => v * 1000 + 1e6), y.map((v) => v / 7 - 3))!.r).toBeCloseTo(base.r, 10);
  });

  it('refuses a constant series on either side — r would be 0/0, not 0', () => {
    expect(pearsonCorrelation([4, 4, 4, 4], [1, 2, 3, 4])).toBeNull();
    expect(pearsonCorrelation([1, 2, 3, 4], [7, 7, 7, 7])).toBeNull();
    // A constant whose mean is not exact in floating point is still constant.
    expect(pearsonCorrelation([0.1, 0.1, 0.1, 0.1], [1, 2, 3, 4])).toBeNull();
  });

  it('needs at least three complete pairs', () => {
    expect(MIN_CORRELATION_PAIRS).toBe(3);
    expect(pearsonCorrelation([], [])).toBeNull();
    expect(pearsonCorrelation([1], [2])).toBeNull();
    expect(pearsonCorrelation([1, 2], [2, 4])).toBeNull();
    expect(pearsonCorrelation([1, 2, 3], [2, 4, 5])).not.toBeNull();
  });

  it('drops any pair with a missing or non-finite value, never treating it as 0', () => {
    const x: Sample = [1, null, 2, 3, undefined, 4, NaN, 5, Infinity];
    const y: Sample = [2, 100, 4, 6, 100, 8, 100, 10, 100];
    expect(pearsonCorrelation(x, y)).toEqual({ r: 1, n: 5, pValue: 0 });
    // A gap on the y side drops the pair too.
    expect(pearsonCorrelation([1, 2, 3, 4], [2, null, 6, -Infinity])).toBeNull();
  });

  it('pairs by index and refuses series of different lengths', () => {
    expect(() => pearsonCorrelation([1, 2, 3], [1, 2])).toThrow();
  });

  it('never exposes NaN or Infinity', () => {
    const series: Array<[Sample, Sample]> = [
      [[1, 2, 3], [3, 2, 1]],
      [[1e-300, 2e-300, 3e-300], [1, 2, 4]],
      [[1e150, 2e150, 3e150, 5e150], [1, 3, 2, 5]],
      [[1, 1, 2], [5, 5, 6]],
    ];
    for (const [x, y] of series) {
      const result = pearsonCorrelation(x, y);
      if (result) expect(allFinite(result)).toBe(true);
    }
  });
});

describe('correlationPValue', () => {
  it('matches an independent numerical integration of the t distribution', () => {
    // Reference values computed by integrating the t density directly.
    expect(correlationPValue(Math.sqrt(0.3), 14)!).toBeCloseTo(0.0426, 4);
    expect(correlationPValue(0.45, 30)!).toBeCloseTo(0.0126, 4);
  });

  it('shrinks as the sample grows for the same r', () => {
    expect(correlationPValue(0.45, 10)!).toBeGreaterThan(correlationPValue(0.45, 30)!);
  });

  it('refuses what is not a correlation or not enough pairs', () => {
    expect(correlationPValue(0.5, 2)).toBeNull();
    expect(correlationPValue(1.2, 10)).toBeNull();
    expect(correlationPValue(NaN, 10)).toBeNull();
    expect(correlationPValue(0.5, 10.5)).toBeNull();
    expect(correlationPValue(-1, 10)).toBe(0);
  });
});

describe('linearRegression', () => {
  it('fits a perfect positive line', () => {
    expect(linearRegression([0, 1, 2, 3], [1, 3, 5, 7])).toEqual({ slope: 2, intercept: 1, rSquared: 1, n: 4 });
  });

  it('fits a perfect negative line', () => {
    const result = linearRegression([1, 2, 3, 4], [10, 7, 4, 1])!;
    expect(result.slope).toBeCloseTo(-3, 12);
    expect(result.intercept).toBeCloseTo(13, 12);
    expect(result.rSquared).toBeCloseTo(1, 12);
  });

  it('computes a textbook slope, intercept and R²', () => {
    const result = linearRegression([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])!;
    expect(result.slope).toBeCloseTo(0.6, 12);
    expect(result.intercept).toBeCloseTo(2.2, 12);
    expect(result.rSquared).toBeCloseTo(0.6, 12);
    // R² equals r² for a simple regression.
    expect(result.rSquared!).toBeCloseTo(pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])!.r ** 2, 12);
  });

  it('reports a flat y as slope 0 with no R² — variance explained is 0/0', () => {
    expect(linearRegression([1, 2, 3, 4], [5, 5, 5, 5])).toEqual({ slope: 0, intercept: 5, rSquared: null, n: 4 });
  });

  it('gives a zero slope, not a fabricated one, when y does not move with x', () => {
    const result = linearRegression([1, 2, 3, 4, 5], [2, 1, 0, 1, 2])!;
    expect(result.slope).toBeCloseTo(0, 12);
    expect(result.rSquared).toBeCloseTo(0, 12);
  });

  it('refuses a constant x — no slope describes a vertical cloud', () => {
    expect(linearRegression([3, 3, 3, 3], [1, 2, 3, 4])).toBeNull();
  });

  it('needs at least three complete pairs', () => {
    expect(MIN_REGRESSION_PAIRS).toBe(3);
    expect(linearRegression([1, 2], [1, 2])).toBeNull();
    expect(linearRegression([1, 2, 3], [1, 2, null])).toBeNull();
  });

  it('drops pairs with missing values, keeping the calendar position of the rest', () => {
    // x is a day offset: the gaps must not pull the remaining points together.
    const result = linearRegression([0, 1, 2, 3, 4, 5], [10, null, 14, NaN, 18, 20])!;
    expect(result.n).toBe(4);
    expect(result.slope).toBeCloseTo(2, 12);
    expect(result.intercept).toBeCloseTo(10, 12);
  });

  it('refuses series of different lengths', () => {
    expect(() => linearRegression([1, 2, 3], [1, 2, 3, 4])).toThrow();
  });

  it('stays finite and R² stays in [0, 1] on awkward inputs', () => {
    const cases: Array<[Sample, Sample]> = [
      [[1e150, 2e150, 3e150], [1, 2, 3]],
      [[1, 2, 3, 4], [1e-300, 2e-300, 0, 5e-300]],
      [[0, 1, 2, 3, 4, 5, 6], [3, 1, 4, 1, 5, 9, 2]],
    ];
    for (const [x, y] of cases) {
      const result = linearRegression(x, y);
      if (!result) continue;
      expect(allFinite(result)).toBe(true);
      if (result.rSquared !== null) {
        expect(result.rSquared).toBeGreaterThanOrEqual(0);
        expect(result.rSquared).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('welchTTest', () => {
  // Reference data and results from the standard worked examples of Welch's test
  // (equal sizes: t ≈ −2.46, df ≈ 25.0, p ≈ 0.021; unequal sizes: t ≈ −1.57, df ≈ 9.9, p ≈ 0.149).
  const A1 = [27.5, 21.0, 19.0, 23.6, 17.0, 17.9, 16.9, 20.1, 21.9, 22.6, 23.1, 19.6, 19.0, 21.7, 21.4];
  const A2 = [27.1, 22.0, 20.8, 23.4, 23.4, 23.5, 25.8, 22.0, 24.8, 20.2, 21.9, 22.1, 22.9, 20.5, 24.4];
  const B1 = [17.2, 20.9, 22.6, 18.1, 21.7, 21.4, 23.5, 24.2, 14.7, 21.8];
  const B2 = [
    21.5, 22.8, 21.0, 23.0, 21.6, 23.6, 22.5, 20.7, 23.4, 21.8, 20.7, 21.7, 21.5, 22.5, 23.6, 21.5, 22.5, 23.5, 21.5,
    21.8,
  ];

  it('reproduces the equal-size reference example', () => {
    const result = welchTTest(A1, A2)!;
    expect(result.t).toBeCloseTo(-2.46, 2);
    expect(result.df).toBeCloseTo(24.99, 2);
    expect(result.pValue).toBeCloseTo(0.021, 3);
    expect(result.nA).toBe(15);
    expect(result.nB).toBe(15);
  });

  it('reproduces the unequal-size, unequal-variance reference example', () => {
    const result = welchTTest(B1, B2)!;
    expect(result.t).toBeCloseTo(-1.57, 2);
    expect(result.df).toBeCloseTo(9.9, 1);
    expect(result.pValue).toBeCloseTo(0.149, 3);
    expect([result.nA, result.nB]).toEqual([10, 20]);
  });

  it('reports the means, and flips only the sign of t when the groups swap', () => {
    const ab = welchTTest(B1, B2)!;
    const ba = welchTTest(B2, B1)!;
    expect(ab.meanA).toBeCloseTo(20.61, 10);
    expect(ab.meanB).toBeCloseTo(22.135, 10);
    expect(ba.t).toBeCloseTo(-ab.t, 12);
    expect(ba.df).toBeCloseTo(ab.df, 12);
    expect(ba.pValue).toBeCloseTo(ab.pValue, 12);
  });

  it('gives t = 0 and p = 1 for identical samples', () => {
    const result = welchTTest([1, 2, 3, 4], [1, 2, 3, 4])!;
    expect(result.t).toBe(0);
    expect(result.pValue).toBeCloseTo(1, 12);
  });

  it('works when one group is constant, and refuses when both are', () => {
    const oneConstant = welchTTest([5, 5, 5], [1, 2, 3, 4])!;
    expect(oneConstant.df).toBeCloseTo(3, 12);
    expect(allFinite(oneConstant)).toBe(true);
    // Both constant: no sampling variation to test against — neither "p = 1" nor "p = 0".
    expect(welchTTest([5, 5, 5], [5, 5])).toBeNull();
    expect(welchTTest([5, 5, 5], [7, 7])).toBeNull();
  });

  it('needs at least two observations in each group', () => {
    expect(MIN_WELCH_GROUP).toBe(2);
    expect(welchTTest([1], [1, 2, 3])).toBeNull();
    expect(welchTTest([1, 2, 3], [])).toBeNull();
    expect(welchTTest([1, 2], [3, 4])).not.toBeNull();
  });

  it('drops missing and non-finite values from each group on its own', () => {
    const clean = welchTTest([1, 2, 3, 4], [3, 5, 7])!;
    const dirty = welchTTest([1, null, 2, NaN, 3, undefined, 4], [Infinity, 3, 5, -Infinity, 7])!;
    expect(dirty).toEqual(clean);
    expect(welchTTest([1, null, NaN], [1, 2, 3])).toBeNull();
  });

  it('never exposes NaN or Infinity', () => {
    const cases: Array<[Sample, Sample]> = [
      [[1e150, 2e150, 3e150], [1, 2, 3]],
      [[1e-300, 2e-300], [3e-300, 4e-300]],
      [[0, 0, 1], [0, 1, 1]],
      [A1, B2],
    ];
    for (const [a, b] of cases) {
      const result = welchTTest(a, b);
      if (result) expect(allFinite(result)).toBe(true);
    }
  });
});

describe('determinism', () => {
  it('returns identical results for identical input', () => {
    const x = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
    const y = [2, 7, 1, 8, 2, 8, 1, 8, 2, 8];
    expect(pearsonCorrelation(x, y)).toEqual(pearsonCorrelation([...x], [...y]));
    expect(linearRegression(x, y)).toEqual(linearRegression([...x], [...y]));
    expect(welchTTest(x, y)).toEqual(welchTTest([...x], [...y]));
  });
});
