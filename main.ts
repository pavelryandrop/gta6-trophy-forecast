// Forecast for make.fun gta6-trophy-rarity-forecast-01.
//
// What an Exophase earn rate is: the share of the players tracked so far who have
// earned a trophy. Over launch week it moves for two reasons at once — players
// already tracked keep earning, while new players join the tracked pool with almost
// nothing earned — so on the logit scale a trophy's rate drifts, roughly linearly
// against log time since release, and slows as the reachable population saturates.
// This program fits that drift per trophy from the whole recorded history instead
// of trusting only the last read, shrinks noisy slopes toward the pooled slope,
// blends the trend with persistence, and widens the spread where the fit is weak
// or the rate sits on the 0.01% print floor. Story trophies are kept in completion
// order (a later chapter can never be earned by more players than an earlier one),
// the platinum can never exceed any other trophy, and 100% completion can never
// exceed the final mission. Everything runs offline on the standard library only,
// and the output is deterministic: same input, same bytes.
//
// How it differs from the house baseline (last rate + random-walk spread): the
// baseline ignores the history's direction entirely. Here the median moves with
// the fitted trend, and the spread is per trophy — tight where the history is
// long and steady, wide where the trophy is pinned at 0.01% and could break out.
//
// Usage (outside the grader): mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');
const MS_PER_HOUR = 3_600_000;
/** How far back the trend fit looks, in hours before the case's checkpoint. */
const FIT_WINDOW_HOURS = 48;
/** Random-walk spread of the logit rate, per square-root day, for the part of the
 *  future no trend can foresee (new refreshes, weekend surges of new players). */
const RW_SIGMA = 0.35;
/** Extra spread for Exophase refresh shocks, which move every rate at once. */
const SHOCK = 0.2;
/** Scale of the cross-trophy spread of slopes, used to shrink noisy slopes. */
const SLOPE_TAU = 0.6;
/** Small upward tilt, in logit units, for trophies pinned at the print floor. */
const FLOOR_NUDGE = 0.2;

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
}

interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface CaseFile {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  levels: number[];
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const sigmoidPct = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const hoursSinceRelease = (iso: string): number =>
  (Date.parse(iso) - RELEASE_MS) / MS_PER_HOUR;

interface TrendFit {
  /** Weighted mean of log-time, the anchor the trend line is re-centred on. */
  xBar: number;
  /** Weighted mean of the logit rate at xBar. */
  yBar: number;
  /** Slope of logit rate against log time. */
  slope: number;
  /** Standard error of the slope. */
  seSlope: number;
  /** Residual spread of the logit rate around the line. */
  resid: number;
  /** Number of reads the fit used. */
  n: number;
}

/** Weighted least squares of y = yBar + slope * (x - xBar). */
function fitTrend(xs: number[], ys: number[], ws: number[]): TrendFit {
  const n = xs.length;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sw += ws[i];
    sx += ws[i] * xs[i];
    sy += ws[i] * ys[i];
  }
  const xBar = sw > 0 ? sx / sw : 0;
  const yBar = sw > 0 ? sy / sw : 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xBar;
    sxx += ws[i] * dx * dx;
    sxy += ws[i] * dx * (ys[i] - yBar);
  }
  const slope = sxx > 1e-9 ? sxy / sxx : 0;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (yBar + slope * (xs[i] - xBar));
    rss += ws[i] * r * r;
  }
  const dof = Math.max(1, n - 2);
  const resid = Math.sqrt(rss / Math.max(sw, 1e-9) / dof * n);
  const seSlope = sxx > 1e-9 ? resid / Math.sqrt(sxx) : Number.POSITIVE_INFINITY;
  return { xBar, yBar, slope, seSlope, resid, n };
}

/** Where a trophy sits in the story chain, or -1 when it is not a story trophy:
 *  0 Chapter 1, 1 Chapter 2, 2 Chapter 3, 3 Chapter 4, 4 the final mission. */
function storyStep(t: Trophy): number {
  const d = t.description.trim().toLowerCase();
  if (d.startsWith('complete chapter 1')) return 0;
  if (d.startsWith('complete chapter 2')) return 1;
  if (d.startsWith('complete chapter 3')) return 2;
  if (d.startsWith('complete chapter 4')) return 3;
  if (d === 'complete the final mission.') return 4;
  return -1;
}

function forecastCase(c: CaseFile): { trophies: Array<{ id: number; q: number[] }> } {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${c.id} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${c.id} has no history`);

  const checkpointH = hoursSinceRelease(c.at);
  const targetH = hoursSinceRelease(c.target);
  const xTarget = Math.log1p(Math.max(0, targetH));
  const horizonDays = Math.max(0, c.horizon_minutes / 1440);
  const rwSpread = RW_SIGMA * Math.sqrt(horizonDays);
  const windowStart = checkpointH - FIT_WINDOW_HOURS;

  // First pass: fit a log-time trend for every trophy from its own history.
  const fits: Array<TrendFit | null> = c.trophies.map((_t, i) => {
    const xs: number[] = [];
    const ys: number[] = [];
    const ws: number[] = [];
    let tFirst = Number.POSITIVE_INFINITY;
    let tLast = Number.NEGATIVE_INFINITY;
    const rows: Array<{ t: number; y: number }> = [];
    for (const read of c.history) {
      const rate = read.rates[i];
      if (rate === null || rate === undefined) continue;
      const t = hoursSinceRelease(read.at);
      if (t < windowStart) continue;
      rows.push({ t, y: logit(rate) });
      if (t < tFirst) tFirst = t;
      if (t > tLast) tLast = t;
    }
    if (rows.length < 2) {
      // Too little inside the window: fall back to the whole history.
      rows.length = 0;
      for (const read of c.history) {
        const rate = read.rates[i];
        if (rate === null || rate === undefined) continue;
        const t = hoursSinceRelease(read.at);
        rows.push({ t, y: logit(rate) });
        if (t < tFirst) tFirst = t;
        if (t > tLast) tLast = t;
      }
    }
    if (rows.length < 2) return null;
    const span = Math.max(1e-9, tLast - tFirst);
    for (const r of rows) {
      xs.push(Math.log1p(Math.max(0, r.t)));
      ys.push(r.y);
      ws.push(0.5 + 0.5 * ((r.t - tFirst) / span));
    }
    return fitTrend(xs, ys, ws);
  });

  // Pooled slope: the median slope over trophies whose own slope is measured
  // precisely enough to trust. Noisy trophies shrink toward this.
  const measured = fits.filter(
    (f): f is TrendFit => f !== null && f.n >= 8 && Number.isFinite(f.seSlope) && f.seSlope < 0.75,
  );
  const pooledSlope = measured.length > 0 ? median(measured.map((f) => f.slope)) : 0;

  const lastRates: number[] = c.trophies.map((_t, i) => {
    for (let h = c.history.length - 1; h >= 0; h--) {
      const r = c.history[h].rates[i];
      if (r !== null && r !== undefined) return r;
    }
    return 1;
  });

  // Second pass: median and spread per trophy.
  const medians: number[] = [];
  const spreads: number[] = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const fit = fits[i];
    const last = lastRates[i];
    const yLast = logit(last);
    let yMed = yLast;
    let spread = 1.6;
    if (fit !== null) {
      // Shrink the slope toward the pooled slope; a precisely measured zero
      // stays zero, an imprecise slope is pulled to the pool.
      const lambda = (SLOPE_TAU * SLOPE_TAU) / (SLOPE_TAU * SLOPE_TAU + fit.seSlope * fit.seSlope);
      const slope = lambda * fit.slope + (1 - lambda) * pooledSlope;
      const yTrend = fit.yBar + slope * (xTarget - fit.xBar);
      // How much to trust the trend over persistence: only a slope that stands
      // out from its own error, fitted on enough reads, earns a big weight.
      const sig = Math.abs(slope) / Math.max(fit.seSlope, 0.08);
      let wTrend = sig > 2 ? 0.8 : sig > 1.2 ? 0.6 : sig > 0.6 ? 0.45 : 0.3;
      if (fit.n < 4) wTrend = Math.min(wTrend, 0.3);
      yMed = wTrend * yTrend + (1 - wTrend) * yLast;
      // A trophy pinned at the 0.01% print floor has a one-sided future: it can
      // only stay or break out, so tilt its median up a little and let the wide
      // spread below carry the honest upside.
      if (last <= 0.02) yMed += FLOOR_NUDGE;
      const paramErr = fit.seSlope * Math.abs(xTarget - fit.xBar);
      spread = Math.sqrt(
        fit.resid * fit.resid + rwSpread * rwSpread + paramErr * paramErr + SHOCK * SHOCK,
      );
    }
    // Spread floor by rate band: rare trophies are the least predictable, and
    // the logit scale punishes a narrow band that misses a breakout hardest.
    const floorSpread = last <= 0.1 ? 1.3 : last <= 1 ? 0.9 : last <= 10 ? 0.6 : 0.45;
    spread = Math.min(2.2, Math.max(floorSpread, spread));
    medians.push(clampPct(sigmoidPct(yMed)));
    spreads.push(spread);
  }

  // A cap taken from another trophy's median is lifted by half that trophy's
  // spread: the minimum of noisy medians sits below the minimum of the true
  // rates, so a hard cap would drag the capped trophy down for no reason.
  // Story order: a later chapter's median can never exceed an earlier one's.
  const SOFT_CAP = 0.5;
  const steps = c.trophies.map(storyStep);
  let capLogit = Number.POSITIVE_INFINITY;
  for (let step = 0; step <= 4; step++) {
    for (let i = 0; i < c.trophies.length; i++) {
      if (steps[i] !== step) continue;
      const capped = Math.min(logit(medians[i]), capLogit);
      medians[i] = clampPct(sigmoidPct(capped));
      capLogit = capped + SOFT_CAP * spreads[i];
    }
  }
  // 100% completion can never exceed the final mission.
  const finalIdx = steps.findIndex((s) => s === 4);
  const completionIdx = c.trophies.findIndex((t) =>
    t.description.toLowerCase().includes('100% completion'),
  );
  if (finalIdx >= 0 && completionIdx >= 0) {
    const cap = logit(medians[finalIdx]) + SOFT_CAP * spreads[finalIdx];
    medians[completionIdx] = Math.min(medians[completionIdx], clampPct(sigmoidPct(cap)));
  }
  // The platinum needs every other trophy, so it can never exceed the rarest one.
  const platinumIdx = c.trophies.findIndex((t) => t.tier === 'platinum');
  if (platinumIdx >= 0) {
    let cap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < c.trophies.length; i++) {
      if (i === platinumIdx) continue;
      cap = Math.min(cap, logit(medians[i]) + SOFT_CAP * spreads[i]);
    }
    if (Number.isFinite(cap)) {
      medians[platinumIdx] = Math.min(medians[platinumIdx], clampPct(sigmoidPct(cap)));
    }
  }

  const rows = c.trophies.map((t, i) => {
    const centre = logit(medians[i]);
    const s = spreads[i];
    const q = Z.map((z) => clampPct(round4(sigmoidPct(centre + z * s))));
    // Rounding can only tie neighbours, never reverse them, but enforce it.
    for (let j = 1; j < q.length; j++) {
      if (q[j] < q[j - 1]) q[j] = q[j - 1];
    }
    return { id: t.id, q };
  });
  return { trophies: rows };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  const forecast = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies: forecast.trophies })}\n`);
}
