/**
 * Temple Digital Group — Trading Bot
 * Main orchestrator: Auth → Seed → Subscribe → Trade → Monitor
 */

import { TempleClient, CandleData } from "../api/client";
import { MAStrategy } from "../strategy/ma";
import { RiskManager } from "../risk/manager";
import { OrderExecutor } from "../core/executor";
import { config } from "../../config";
import { logger } from "../logger";

interface WsTicker {
  symbol: string;
  lastPrice: number | string;
}

interface WsCandle {
  symbol: string;
  closed?: boolean;
  t?: number; o?: number; h?: number; l?: number; c?: number; v?: number;
  timestamp?: number; open?: number; high?: number; low?: number; close?: number; volume?: number;
}

function parseWsCandle(raw: WsCandle): CandleData {
  return {
    timestamp: raw.t ?? raw.timestamp ?? 0,
    open: raw.o ?? raw.open ?? 0,
    high: raw.h ?? raw.high ?? 0,
    low: raw.l ?? raw.low ?? 0,
    close: raw.c ?? raw.close ?? 0,
    volume: raw.v ?? raw.volume ?? 0,
  };
}

export class TradingBot {
  private api = new TempleClient();
  private risk = new RiskManager();
  private executor: OrderExecutor;
  private strategies = new Map<string, MAStrategy>();
  private lastPrices = new Map<string, number>();
  private running = false;

  constructor() {
    this.executor = new OrderExecutor(this.api, this.risk);
    for (const pair of config.trading.pairs) {
      this.strategies.set(pair, new MAStrategy());
    }
  }

  async start(): Promise<void> {
    this._banner();

    // 1. Authenticate
    await this.api.login();

    // 2. Load symbol configs and seed strategies
    await this._seedStrategies();

    // 3. Connect WebSocket & subscribe to feeds
    await this.api.connectWs();
    this._setupWsFeeds();

    // 4. Graceful shutdown handlers
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());

    this.running = true;
    logger.info("🚀 Bot running. Monitoring: %s", config.trading.pairs.join(", "));

    // 5. Heartbeat loop
    while (this.running) {
      await sleep(config.heartbeatIntervalMs);
      await this._checkExits();
      this._logStatus();
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    logger.info("Shutdown initiated...");
    await this.executor.cancelAll();
    await this.api.disconnect();
    logger.info("Bot stopped. Final status: %j", this.risk.summary());
    process.exit(0);
  }

  // ── Strategy Seeding ───────────────────────────────────────────────────────

  private async _seedStrategies(): Promise<void> {
    for (const pair of config.trading.pairs) {
      try {
        logger.info("Fetching symbol config for %s...", pair);
        const symCfg = await this.api.getSymbolConfig(pair);
        logger.info("  %s | minQty=%s tickSize=%s", pair, symCfg.minOrderQuantity, symCfg.tickSize);

        logger.info("Fetching historical candles for %s...", pair);
        const candles = await this.api.getCandles(
          pair,
          config.trading.candleInterval,
          config.strategy.historicalCandleCount
        );
        this.strategies.get(pair)!.loadHistory(candles);
        logger.info("  ✓ %s seeded with %d candles", pair, candles.length);
      } catch (err) {
        logger.error("Failed to seed %s: %s", pair, err);
      }
    }
  }

  // ── WebSocket Feed Setup ───────────────────────────────────────────────────

  private _setupWsFeeds(): void {
    // Ticker → track latest price for exit checks
    this.api.onWs("ticker", (raw) => {
      const msg = raw as WsTicker;
      if (msg?.symbol && msg?.lastPrice) {
        this.lastPrices.set(msg.symbol, parseFloat(String(msg.lastPrice)));
      }
    });

    // Candle close → run strategy
    this.api.onWs("candle", (raw) => {
      const msg = raw as WsCandle;
      const pair = msg?.symbol;
      if (!pair || !this.strategies.has(pair)) return;
      if (!msg.closed) return; // Only act on confirmed closed candles

      const candle = parseWsCandle(msg);
      this._processCandle(pair, candle).catch((e) =>
        logger.error("processCandle error [%s]: %s", pair, e)
      );
    });

    // Fill notifications
    this.api.onWs("fills", (raw) => {
      logger.info("Fill received: %j", raw);
    });

    // Subscribe to channels for each pair
    for (const pair of config.trading.pairs) {
      this.api.subscribe("ticker", { symbol: pair });
      this.api.subscribe("candle", { symbol: pair, interval: config.trading.candleInterval });
    }
    this.api.subscribe("orders");
    this.api.subscribe("fills");
  }

  // ── Core Signal Processing ─────────────────────────────────────────────────

  private async _processCandle(pair: string, candle: CandleData): Promise<void> {
    const strategy = this.strategies.get(pair)!;
    const result = strategy.onCandle(candle);

    logger.debug(
      "[%s] price=%.4f fastMA=%.4f slowMA=%.4f RSI=%s signal=%s",
      pair, candle.close, result.fastMa, result.slowMa,
      result.rsi ? result.rsi.toFixed(1) : "N/A",
      result.signal
    );

    if (result.signal === "BUY") {
      // Reverse short → long if needed
      const existing = this.risk.openPositions.get(pair);
      if (existing?.side === "short") {
        logger.info("[%s] Reversing short → long", pair);
        await this.executor.closePosition(pair, candle.close);
        await sleep(200);
      }
      await this.executor.openLong(pair, candle.close);

    } else if (result.signal === "SELL") {
      // Reverse long → short if needed
      const existing = this.risk.openPositions.get(pair);
      if (existing?.side === "long") {
        logger.info("[%s] Reversing long → short", pair);
        await this.executor.closePosition(pair, candle.close);
        await sleep(200);
      }
      await this.executor.openShort(pair, candle.close);
    }
  }

  // ── SL/TP Exit Monitoring ─────────────────────────────────────────────────

  private async _checkExits(): Promise<void> {
    for (const [pair, pos] of this.risk.openPositions) {
      const price = this.lastPrices.get(pair);
      if (!price) continue;
      const exitReason = this.risk.checkExits(pair, price);
      if (exitReason) {
        logger.info("Exit triggered [%s] for %s @ %.4f (%s)", exitReason, pair, price, pos.side);
        await this.executor.closePosition(pair, price);
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _logStatus(): void {
    const s = this.risk.summary();
    const prices = Object.fromEntries(
      [...this.lastPrices.entries()].map(([k, v]) => [k, `$${v.toLocaleString()}`])
    );
    logger.info(
      "Heartbeat | positions=%d | daily_pnl=$%.2f | cb=%s | prices=%j",
      s.openPositions, s.dailyPnlUsd, s.circuitBreaker ? "ON 🚨" : "off", prices
    );
  }

  private _banner(): void {
    logger.info("═".repeat(58));
    logger.info("  Temple Digital Group — Algorithmic Trading Bot");
    logger.info("  Canton Network | MA Crossover Strategy");
    logger.info("  API: %s", config.temple.restUrl);
    logger.info("  Mode: %s", config.dryRun ? "⚠️  DRY RUN" : "🔴 LIVE TRADING");
    logger.info("═".repeat(58));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
