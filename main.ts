// Trend-following bot for the make.fun cbBTC bars-replay race.
// Bot name: "Sabar Trend Rider" — patient, one position, no chasing.
//
// Strategy (long only, one position, all-in/all-out): ride the trend,
// do not chase crosses. One-minute bars are noisy, so a single slow
// trend filter decides, with a wide exit band and confirmations so
// ordinary pullbacks never shake the position out:
// - The trend gauge is the EMA of the last 120 closes (2 hours).
// - Enter when the close is above that EMA and above its own value
//   60 bars ago, on 2 consecutive bars: an established uptrend with
//   room to pay the ~26 bps full-size round-trip cost.
// - Exit only when the close falls 0.8% under the EMA on 3
//   consecutive bars (a real trend break, not a dip), or on a hard
//   stop 2.5% under the position's cost.
// - After an exit, cool down 30 bars before re-entering.
// Deterministic: a pure function of the bars seen; no clock, no
// randomness, no network. The EMA runs in float64 on + - * / alone.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';
const TREND_N = 120;
const MOM_N = 60;
const SLIP_BPS = 250;
const EXIT_BAND = 0.992; // trend break: close under 99.2% of the trend EMA
const STOP_LOSS = 0.975; // hard stop: position worth < 97.5% of its cost
const ENTER_CONFIRM = 2;
const EXIT_CONFIRM = 3;
const COOLDOWN = 30;
const LATE_BAR = 1400; // no fresh entries this late in a 1,440-bar window
const MIN_NOTIONAL = 1_000_000n; // 1 USDC in quote units

const K_TREND = 2 / (TREND_N + 1);

let n = 0;
let ema: number | null = null;
const closes: number[] = [];
let entryCost: bigint | null = null;
let cool = 0;
let upStreak = 0;
let downStreak = 0;

function onBatch(state: BarsState, _batch: Batch): OrderInput[] | null {
  const close = state.close(SYM);
  if (close === null) return null;
  const c = Number(close);
  n += 1;
  if (ema === null) {
    ema = c;
  } else {
    ema += K_TREND * (c - ema);
  }
  closes.push(c);
  if (closes.length > MOM_N + 1) closes.shift();
  if (cool > 0) cool -= 1;

  const held = state.positions.get(SYM);
  if (held !== undefined) {
    if (entryCost !== held.cost) entryCost = held.cost;
    const below = c < ema * EXIT_BAND;
    downStreak = below ? downStreak + 1 : 0;
    let stopped = false;
    if (held.cost > 0n) {
      stopped = Number(state.value(SYM, held.qty)) < Number(held.cost) * STOP_LOSS;
    }
    if (downStreak >= EXIT_CONFIRM || stopped) {
      cool = COOLDOWN;
      entryCost = null;
      downStreak = 0;
      upStreak = 0;
      return [{ side: 'sell', symbol: SYM, qty: held.qty, max_slippage_bps: SLIP_BPS }];
    }
    return null;
  }

  entryCost = null;
  downStreak = 0;
  if (state.warmingUp || cool > 0 || n < TREND_N || n > LATE_BAR) {
    upStreak = 0;
    return null;
  }
  const momentum = closes.length > MOM_N && c > closes[0];
  const trendUp = c > ema && momentum;
  upStreak = trendUp ? upStreak + 1 : 0;
  if (upStreak >= ENTER_CONFIRM) {
    const room = state.weightRoom(SYM);
    const byCash = (state.cash * 98n) / 100n;
    const spend = byCash < room ? byCash : room;
    if (spend >= MIN_NOTIONAL) {
      upStreak = 0;
      return [{ side: 'buy', symbol: SYM, notional_quote_units: spend, max_slippage_bps: SLIP_BPS }];
    }
  }
  return null;
}

await runBars({ onBatch });
