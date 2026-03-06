/**
 * Moving Average Crossover Strategy
 * EMA/SMA golden cross / death cross with RSI & volume filters.
 */

import { CandleData } from "../api/client";
import { config } from "../../config";
import { logger } from "../logger";

export type Signal = "BUY" | "SELL" | "HOLD";

export interface StrategyResult {
  signal: Signal;
  fastMa: number;
  slowMa: number;
  rsi: number | null;
  price: number;
  reason: string;
}

// ── Indicators ───────────────────────────────────────────────────────────────

function ema(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  const k = 2 / (period + 1);
  let val = prices[0];
  for (let i = 1; i < prices.length; i++) {
    val = prices[i] * k + val * (1 - k);
  }
  return val;
}

function sma(prices: number[], period: number): number {
  const window = prices.slice(-period);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

function rsi(prices: number[], period = 14): number | null {
  if (prices.length < period + 1) return null;
  const deltas = prices.slice(1).map((p, i) => p - prices[i]);
  const recent = deltas.slice(-period);
  const gains = recent.map((d) => Math.max(d, 0));
  const losses = recent.map((d) => Math.abs(Math.min(d, 0)));
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ── Strategy ─────────────────────────────────────────────────────────────────

export class MAStrategy {
  private candles: CandleData[] = [];
  private prevFastAboveSlow: boolean | null = null;
  private readonly cfg = config.strategy;

  private readonly maxBuffer =
    Math.max(this.cfg.slowPeriod, this.cfg.rsiPeriod, this.cfg.volumeMaPeriod) * 3;

  loadHistory(history: CandleData[]): void {
    this.candles = history.slice(-this.maxBuffer);
    // Prime crossover state without emitting signal
    const result = this._evaluate(false);
    if (result) {
      this.prevFastAboveSlow = result.fastMa > result.slowMa;
      logger.info(
        "Strategy seeded: %d candles | fast=%.4f slow=%.4f (%s)",
        this.candles.length,
        result.fastMa,
        result.slowMa,
        this.prevFastAboveSlow ? "fast above slow" : "fast below slow"
      );
    }
  }

  onCandle(candle: CandleData): StrategyResult {
    this.candles.push(candle);
    if (this.candles.length > this.maxBuffer) {
      this.candles.shift();
    }
    return this._evaluate(true)!;
  }

  private _evaluate(emit: boolean): StrategyResult | null {
    const closes = this.candles.map((c) => c.close);
    const volumes = this.candles.map((c) => c.volume);

    if (closes.length < this.cfg.slowPeriod) {
      return {
        signal: "HOLD",
        fastMa: closes.at(-1) ?? 0,
        slowMa: closes.at(-1) ?? 0,
        rsi: null,
        price: closes.at(-1) ?? 0,
        reason: `Insufficient candles (${closes.length}/${this.cfg.slowPeriod})`,
      };
    }

    const ma = this.cfg.maType === "ema" ? ema : (p: number[], n: number) => sma(p, n);
    const fastMa = ma(closes, this.cfg.fastPeriod);
    const slowMa = ma(closes, this.cfg.slowPeriod);
    const price = closes.at(-1)!;
    const rsiVal = this.cfg.useRsiFilter ? rsi(closes, this.cfg.rsiPeriod) : null;
    const gapPct = Math.abs(fastMa - slowMa) / slowMa * 100;

    // Volume filter
    let volOk = true;
    if (this.cfg.useVolumeFilter && volumes.length >= this.cfg.volumeMaPeriod) {
      const avgVol =
        volumes.slice(-this.cfg.volumeMaPeriod).reduce((a, b) => a + b, 0) /
        this.cfg.volumeMaPeriod;
      volOk = volumes.at(-1)! >= avgVol * this.cfg.volumeMultiplier;
    }

    let signal: Signal = "HOLD";
    let reason = "No crossover";

    const fastAboveSlow = fastMa > slowMa;

    if (emit && this.prevFastAboveSlow !== null) {
      const crossedUp = !this.prevFastAboveSlow && fastAboveSlow;
      const crossedDown = this.prevFastAboveSlow && !fastAboveSlow;

      if (crossedUp) {
        reason = `Golden cross: fast(${fastMa.toFixed(4)}) > slow(${slowMa.toFixed(4)}) gap=${gapPct.toFixed(3)}%`;
        if (gapPct < this.cfg.minCrossoverGapPct) {
          reason += ` [FILTERED: gap < ${this.cfg.minCrossoverGapPct}%]`;
        } else if (rsiVal !== null && rsiVal > this.cfg.rsiOverbought) {
          reason += ` [FILTERED: RSI=${rsiVal.toFixed(1)} overbought]`;
        } else if (!volOk) {
          reason += " [FILTERED: low volume]";
        } else {
          signal = "BUY";
        }
      } else if (crossedDown) {
        reason = `Death cross: fast(${fastMa.toFixed(4)}) < slow(${slowMa.toFixed(4)}) gap=${gapPct.toFixed(3)}%`;
        if (gapPct < this.cfg.minCrossoverGapPct) {
          reason += ` [FILTERED: gap < ${this.cfg.minCrossoverGapPct}%]`;
        } else if (rsiVal !== null && rsiVal < this.cfg.rsiOversold) {
          reason += ` [FILTERED: RSI=${rsiVal.toFixed(1)} oversold]`;
        } else if (!volOk) {
          reason += " [FILTERED: low volume]";
        } else {
          signal = "SELL";
        }
      }
    }

    this.prevFastAboveSlow = fastAboveSlow;

    if (signal !== "HOLD") {
      logger.info("⚡ Signal [%s] %s", signal, reason);
    }

    return { signal, fastMa, slowMa, rsi: rsiVal, price, reason };
  }
}
