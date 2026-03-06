import * as dotenv from "dotenv";
dotenv.config();

const e = (key: string, fallback?: string): string => {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env var: ${key}`);
  return val;
};

export const config = {
  // ── Temple Auth ──────────────────────────────────────────
  temple: {
    email: e("TEMPLE_EMAIL"),
    password: e("TEMPLE_PASSWORD"),
    restUrl: e("TEMPLE_REST_URL", "https://api.templedigitalgroup.com"),
    wsUrl: e("TEMPLE_WS_URL", "wss://api.templedigitalgroup.com/ws"),
  },

  // ── Trading ──────────────────────────────────────────────
  trading: {
    pairs: e("TRADING_PAIRS", "BTC-USDCx,ETH-USDCx").split(",").map(s => s.trim()),
    candleInterval: e("CANDLE_INTERVAL", "5m"),
    orderSizeUsd: parseFloat(e("ORDER_SIZE_USD", "1000")),
    maxTotalExposureUsd: parseFloat(e("MAX_TOTAL_EXPOSURE_USD", "50000")),
    maxDailyLossUsd: parseFloat(e("MAX_DAILY_LOSS_USD", "2000")),
    stopLossPct: parseFloat(e("STOP_LOSS_PCT", "2.0")),
    takeProfitPct: parseFloat(e("TAKE_PROFIT_PCT", "4.0")),
    limitSlippageBps: 5,
    maxOpenPositions: 10,
  },

  // ── MA Strategy ──────────────────────────────────────────
  strategy: {
    maType: e("MA_TYPE", "ema") as "ema" | "sma",
    fastPeriod: parseInt(e("FAST_PERIOD", "9")),
    slowPeriod: parseInt(e("SLOW_PERIOD", "21")),
    minCrossoverGapPct: 0.05,
    useRsiFilter: e("USE_RSI_FILTER", "true") === "true",
    rsiPeriod: 14,
    rsiOversold: 35,
    rsiOverbought: 65,
    useVolumeFilter: e("USE_VOLUME_FILTER", "true") === "true",
    volumeMaPeriod: 20,
    volumeMultiplier: 1.2,
    historicalCandleCount: 200,
  },

  // ── Operational ──────────────────────────────────────────
  dryRun: e("DRY_RUN", "true") === "true",
  logLevel: e("LOG_LEVEL", "info"),
  heartbeatIntervalMs: 30_000,
  tokenRefreshBufferMs: 60_000, // refresh token 1 min before expiry
} as const;

export type Config = typeof config;
