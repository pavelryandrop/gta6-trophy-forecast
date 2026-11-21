# GTA VI Trophy Rarity Forecast — make.fun

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/pavelryandrop/gta6-trophy-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/pavelryandrop/gta6-trophy-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts every PlayStation 5 trophy's earn rate on Exophase at the case's target,
for competition [`gta6-trophy-rarity-forecast-01`](https://make.fun/bounty/gta6-trophy-rarity-forecast-01) ($250).

## Entry point

`main.ts` (Node 22, standard library only, no network). It reads every `<id>.in`
case file from `$MAKEFUN_INPUT_DIR` (else `/input`) and writes `<id>.out` to
`$MAKEFUN_OUTPUT_DIR` (else `/output`):

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Each output row is `{"id": N, "q": [q05, q25, q50, q75, q95]}` — five quantiles
of the trophy's earn rate in percent at the case's target.

## The model

An Exophase earn rate is the share of the players tracked so far who have earned
a trophy. Over launch week it moves for two reasons at once: players already
tracked keep earning, while new players join the tracked pool with almost nothing
earned. So on the logit scale a trophy's rate drifts, roughly linearly against
log time since release, and slows as the reachable population saturates.

Per trophy, the program:

1. **Fits a trend** — weighted least squares of `logit(rate)` against
   `ln(1 + hours since release)` over the last 48 hours of reads (recency-weighted),
   falling back to the whole history when there are too few reads.
2. **Shrinks noisy slopes** toward the pooled slope (the median slope over trophies
   whose own slope is measured precisely). A precisely measured zero stays zero;
   an imprecise slope is pulled to the pool.
3. **Blends trend with persistence** — the trend earns a weight of 0.8 only when
   its slope stands out from its own standard error on enough reads; otherwise
   the last observed rate dominates.
4. **Widens the spread where it should be wide** — residual scatter around the
   fit, a random-walk term growing with the square root of the horizon, parameter
   uncertainty from the slope, and a refresh-shock allowance. Rare trophies get a
   higher spread floor (1.3 logit units at ≤0.1%) because the logit scale punishes
   a narrow band that misses a breakout hardest. Trophies pinned at the 0.01%
   print floor get a small upward tilt on the median, since their future is
   one-sided: stay, or break out.
5. **Enforces story order, softly** — a later chapter's median can never exceed
   an earlier one's, 100% completion can never exceed the final mission, and the
   platinum can never exceed the rarest other trophy. The caps are softened by
   half the constraining trophy's spread, because the minimum of noisy medians
   sits below the minimum of the true rates and a hard cap would drag the capped
   trophy down for no reason.

## Why it beats the house baseline

The house baseline (the kit's starter) forecasts that every rate stays where the
last read put it, with a fixed random-walk spread. It ignores the history's
direction entirely. This entry moves the median with the fitted trend — story
trophies that have been climbing keep climbing, at a decelerating log-time pace —
and sizes the spread per trophy from how predictable that trophy has actually
been. The pinball loss on the logit scale rewards exactly that: an honest median
plus an honest spread.

## Calibration notes (from the live Exophase page, ~2 days after release)

- Chapter 1 at ~12%, Chapter 2 at ~1.7%: the story is long, and progression
  through it is slow — most players are still early.
- "Gone Fishing" sits at 100% (every tracked player has it); most other trophies
  are still pinned at the 0.01% print floor.
- The launch-night page (638 players tracked) was refreshed to 3,868 players by
  04:30 UTC on launch day, with almost every rate dropping — Exophase refreshes
  move rates in jumps, which is why the spread carries a shock term.

## Validation

The program is run on the kit's practice cases for output validity and
determinism, and scored against the house baseline on synthetic final-like cases
(ground truth generated from a different curve family than the model's — a
join-rate × Weibull time-to-earn convolution, with dilution shocks) using the
competition's exact pinball loss on the logit scale. Measured results:

| case | shape | this entry | house baseline |
| ---- | ----- | ---------- | -------------- |
| S1 | smooth launch-week growth | 0.17 | 0.32 |
| S2 | weekend dilution surge | 0.18 | 0.31 |
| S3 | fast story saturation | 0.17 | 0.32 |
| S4 | flat history + refresh drop (practice shape) | 1.11 | 1.61 |

Lower is better. The edge comes from the trend median: story trophies that have
been climbing keep climbing at a decelerating log-time pace, while persistence
(the baseline) freezes them at the last read.

## License

MIT — see `LICENSE`.
