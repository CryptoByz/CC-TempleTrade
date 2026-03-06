/**
 * Temple Digital Group — REST + WebSocket Client
 *
 * Endpoints sourced from: https://apidocs.templedigitalgroup.com
 *
 * Auth flow:
 *   POST /auth/login           → { accessToken, refreshToken, expiresIn }
 *   POST /auth/refresh-token   → { accessToken, expiresIn }
 *
 * Market Data (public, no auth):
 *   GET /market/ticker/:symbol
 *   GET /market/orderbook/:symbol
 *   GET /market/min-order-quantity/:symbol
 *   GET /market/open-interest/:symbol
 *   GET /market/symbol-config/:symbol
 *   GET /market/recent-trades/:symbol
 *
 * Orders (authenticated):
 *   GET  /orders/active
 *   POST /orders/cancel
 *   POST /orders/cancel-all
 */

import axios, { AxiosInstance } from "axios";
import axiosRetry from "axios-retry";
import WebSocket from "ws";
import { config } from "../config";
import { logger } from "./logger";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
  expiresAt: number; // Unix ms (computed)
}

export interface Ticker {
  symbol: string;
  lastPrice: number;
  bidPrice: number;
  askPrice: number;
  volume24h: number;
  priceChange24h: number;
  priceChangePct24h: number;
  high24h: number;
  low24h: number;
  timestamp: number;
}

export interface OrderBookEntry {
  price: number;
  quantity: number;
}

export interface OrderBook {
  symbol: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  timestamp: number;
}

export interface RecentTrade {
  id: string;
  symbol: string;
  price: number;
  quantity: number;
  side: "buy" | "sell";
  timestamp: number;
}

export interface SymbolConfig {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  minOrderQuantity: number;
  maxOrderQuantity: number;
  tickSize: number;
  stepSize: number;
  status: string;
}

export interface ActiveOrder {
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  price: number;
  quantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  status: "open" | "partially_filled" | "filled" | "cancelled";
  createdAt: number;
  updatedAt: number;
}

export interface PlaceOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  quantity: string;
  price?: string;
  clientOrderId?: string;
  postOnly?: boolean;
}

export interface PlaceOrderResponse {
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  price: number;
  quantity: number;
  status: string;
  createdAt: number;
}

// ── Temple REST Client ───────────────────────────────────────────────────────

export class TempleClient {
  private http: AxiosInstance;
  private tokens: AuthTokens | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private ws: WebSocket | null = null;
  private wsCallbacks: Map<string, ((data: unknown) => void)[]> = new Map();
  private wsReconnectDelay = 2000;

  constructor() {
    this.http = axios.create({
      baseURL: config.temple.restUrl,
      timeout: 10_000,
      headers: { "Content-Type": "application/json" },
    });

    axiosRetry(this.http, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) =>
        axiosRetry.isNetworkError(err) || (err.response?.status ?? 0) >= 500,
    });

    // Attach auth header on every request
    this.http.interceptors.request.use((reqConfig) => {
      if (this.tokens?.accessToken) {
        reqConfig.headers["Authorization"] = `Bearer ${this.tokens.accessToken}`;
      }
      return reqConfig;
    });
  }

  // ── Authentication ─────────────────────────────────────────────────────────

  async login(): Promise<void> {
    logger.info("Authenticating with Temple Digital Group...");
    const resp = await this.http.post<{
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    }>("/auth/login", {
      email: config.temple.email,
      password: config.temple.password,
    });

    this.tokens = {
      ...resp.data,
      expiresAt: Date.now() + resp.data.expiresIn * 1000,
    };

    this._scheduleTokenRefresh();
    logger.info("✓ Authenticated. Token expires in %ds", resp.data.expiresIn);
  }

  async refreshToken(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      logger.warn("No refresh token — re-authenticating...");
      return this.login();
    }

    try {
      const resp = await this.http.post<{ accessToken: string; expiresIn: number }>(
        "/auth/refresh-token",
        { refreshToken: this.tokens.refreshToken }
      );
      this.tokens.accessToken = resp.data.accessToken;
      this.tokens.expiresIn = resp.data.expiresIn;
      this.tokens.expiresAt = Date.now() + resp.data.expiresIn * 1000;
      this._scheduleTokenRefresh();
      logger.debug("Token refreshed. Next expiry in %ds", resp.data.expiresIn);
    } catch (err) {
      logger.warn("Token refresh failed — re-logging in...");
      await this.login();
    }
  }

  private _scheduleTokenRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (!this.tokens) return;
    const msUntilRefresh = this.tokens.expiresAt - Date.now() - config.tokenRefreshBufferMs;
    this.refreshTimer = setTimeout(
      () => this.refreshToken().catch((e) => logger.error("Token refresh error: %s", e)),
      Math.max(msUntilRefresh, 1000)
    );
  }

  async disconnect(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.ws) this.ws.close();
    logger.info("Temple client disconnected.");
  }

  // ── Market Data (Public) ───────────────────────────────────────────────────

  async getTicker(symbol: string): Promise<Ticker> {
    const { data } = await this.http.get<Ticker>(`/market/ticker/${symbol}`);
    return data;
  }

  async getOrderBook(symbol: string, depth = 20): Promise<OrderBook> {
    const { data } = await this.http.get<OrderBook>(`/market/orderbook/${symbol}`, {
      params: { depth },
    });
    return data;
  }

  async getMinOrderQuantity(symbol: string): Promise<number> {
    const { data } = await this.http.get<{ minQuantity: number }>(
      `/market/min-order-quantity/${symbol}`
    );
    return data.minQuantity;
  }

  async getSymbolConfig(symbol: string): Promise<SymbolConfig> {
    const { data } = await this.http.get<SymbolConfig>(`/market/symbol-config/${symbol}`);
    return data;
  }

  async getRecentTrades(symbol: string, limit = 50): Promise<RecentTrade[]> {
    const { data } = await this.http.get<RecentTrade[]>(`/market/recent-trades/${symbol}`, {
      params: { limit },
    });
    return data;
  }

  async getOpenInterest(symbol: string): Promise<{ symbol: string; openInterest: number }> {
    const { data } = await this.http.get(`/market/open-interest/${symbol}`);
    return data;
  }

  // ── Candles (derived from recent-trades or dedicated endpoint) ─────────────

  async getCandles(
    symbol: string,
    interval: string,
    limit = 200
  ): Promise<CandleData[]> {
    // Temple exposes candle data via /market/candles if available,
    // falling back to constructing from recent trades for lower timeframes.
    try {
      const { data } = await this.http.get<CandleData[]>(`/market/candles/${symbol}`, {
        params: { interval, limit },
      });
      return data;
    } catch {
      logger.warn("Candle endpoint unavailable for %s — using recent trades fallback", symbol);
      return this._candlesFromTrades(symbol, interval, limit);
    }
  }

  private async _candlesFromTrades(
    symbol: string,
    interval: string,
    limit: number
  ): Promise<CandleData[]> {
    const trades = await this.getRecentTrades(symbol, limit * 10);
    return aggregateTradesToCandles(trades, interval, limit);
  }

  // ── Order Management (Authenticated) ──────────────────────────────────────

  async getActiveOrders(symbol?: string): Promise<ActiveOrder[]> {
    const { data } = await this.http.get<ActiveOrder[]>("/orders/active", {
      params: symbol ? { symbol } : undefined,
    });
    return data;
  }

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    const { data } = await this.http.post<PlaceOrderResponse>("/orders", req);
    return data;
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.http.post("/orders/cancel", { orderId });
  }

  async cancelAllOrders(symbol?: string): Promise<void> {
    await this.http.post("/orders/cancel-all", symbol ? { symbol } : {});
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  async connectWs(): Promise<void> {
    const wsUrl = `${config.temple.wsUrl}?token=${this.tokens?.accessToken ?? ""}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      logger.info("WebSocket connected → %s", config.temple.wsUrl);
      this.wsReconnectDelay = 2000;
    });

    this.ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { channel: string; data: unknown };
        const handlers = this.wsCallbacks.get(msg.channel) ?? [];
        handlers.forEach((h) => h(msg.data));
      } catch (e) {
        logger.debug("WS parse error: %s", e);
      }
    });

    this.ws.on("close", (code) => {
      logger.warn("WebSocket closed (code=%d) — reconnecting in %dms", code, this.wsReconnectDelay);
      setTimeout(() => this.connectWs(), this.wsReconnectDelay);
      this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 2, 60_000);
    });

    this.ws.on("error", (err) => logger.error("WebSocket error: %s", err.message));
  }

  onWs(channel: string, cb: (data: unknown) => void): void {
    if (!this.wsCallbacks.has(channel)) this.wsCallbacks.set(channel, []);
    this.wsCallbacks.get(channel)!.push(cb);
  }

  sendWs(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  subscribe(channel: string, params: object = {}): void {
    this.sendWs({ action: "subscribe", channel, ...params });
    logger.debug("WS subscribe: %s %j", channel, params);
  }
}

// ── Candle Types & Aggregation ────────────────────────────────────────────────

export interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function intervalToMs(interval: string): number {
  const map: Record<string, number> = {
    "1m": 60_000, "5m": 300_000, "15m": 900_000,
    "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
  };
  return map[interval] ?? 300_000;
}

function aggregateTradesToCandles(
  trades: RecentTrade[],
  interval: string,
  limit: number
): CandleData[] {
  const ms = intervalToMs(interval);
  const buckets = new Map<number, CandleData>();

  for (const t of trades) {
    const bucket = Math.floor(t.timestamp / ms) * ms;
    if (!buckets.has(bucket)) {
      buckets.set(bucket, {
        timestamp: bucket,
        open: t.price, high: t.price, low: t.price, close: t.price, volume: 0,
      });
    }
    const c = buckets.get(bucket)!;
    c.high = Math.max(c.high, t.price);
    c.low = Math.min(c.low, t.price);
    c.close = t.price;
    c.volume += t.quantity;
  }

  return [...buckets.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-limit);
}
