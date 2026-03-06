import { config } from "../../config";
import { logger } from "../logger";

export interface Position {
  pair: string;
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
  orderId: string;
}

export class RiskManager {
  private positions = new Map<string, Position>();
  private dailyPnl = 0;
  private circuitBreaker = false;
  private dailyDate = new Date().toDateString();
  private readonly cfg = config.trading;

  canTrade(pair: string, side: "long" | "short"): { allowed: boolean; reason: string } {
    this._checkDailyReset();
    if (this.circuitBreaker) {
      return { allowed: false, reason: `Circuit breaker ON — daily loss exceeded $${this.cfg.maxDailyLossUsd}` };
    }
    if (this.positions.size >= this.cfg.maxOpenPositions) {
      return { allowed: false, reason: `Max open positions (${this.cfg.maxOpenPositions}) reached` };
    }
    const existing = this.positions.get(pair);
    if (existing?.side === side) {
      return { allowed: false, reason: `Already ${side} on ${pair}` };
    }
    const exposure = [...this.positions.values()].reduce(
      (sum, p) => sum + p.entryPrice * p.qty, 0
    );
    if (exposure + this.cfg.orderSizeUsd > this.cfg.maxTotalExposureUsd) {
      return { allowed: false, reason: `Max exposure $${this.cfg.maxTotalExposureUsd} would be exceeded` };
    }
    return { allowed: true, reason: "OK" };
  }

  computeQty(price: number): number {
    return parseFloat((this.cfg.orderSizeUsd / price).toFixed(8));
  }

  computeLimitPrice(side: "buy" | "sell", midPrice: number): number {
    const tick = midPrice * (this.cfg.limitSlippageBps / 10_000);
    return parseFloat((side === "buy" ? midPrice + tick : midPrice - tick).toFixed(8));
  }

  computeStopTake(side: "long" | "short", entry: number): { stop: number; take: number } {
    const sl = this.cfg.stopLossPct / 100;
    const tp = this.cfg.takeProfitPct / 100;
    if (side === "long") {
      return {
        stop: parseFloat((entry * (1 - sl)).toFixed(8)),
        take: parseFloat((entry * (1 + tp)).toFixed(8)),
      };
    }
    return {
      stop: parseFloat((entry * (1 + sl)).toFixed(8)),
      take: parseFloat((entry * (1 - tp)).toFixed(8)),
    };
  }

  openPosition(pos: Position): void {
    this.positions.set(pos.pair, pos);
    logger.info(
      "Position OPENED: %s %s qty=%.6f @ %.4f | SL=%.4f TP=%.4f",
      pos.side.toUpperCase(), pos.pair, pos.qty, pos.entryPrice, pos.stopLoss, pos.takeProfit
    );
  }

  closePosition(pair: string, exitPrice: number): number | null {
    const pos = this.positions.get(pair);
    if (!pos) return null;
    this.positions.delete(pair);
    const pnl =
      pos.side === "long"
        ? (exitPrice - pos.entryPrice) * pos.qty
        : (pos.entryPrice - exitPrice) * pos.qty;
    this.dailyPnl += pnl;
    logger.info(
      "Position CLOSED: %s %s @ %.4f | PnL: $%.2f | Daily PnL: $%.2f",
      pos.side.toUpperCase(), pair, exitPrice, pnl, this.dailyPnl
    );
    if (this.dailyPnl <= -Math.abs(this.cfg.maxDailyLossUsd)) {
      this.circuitBreaker = true;
      logger.error(
        "🚨 CIRCUIT BREAKER TRIGGERED — daily loss $%.2f exceeded limit $%.2f",
        this.dailyPnl, this.cfg.maxDailyLossUsd
      );
    }
    return pnl;
  }

  checkExits(pair: string, price: number): "stop_loss" | "take_profit" | null {
    const pos = this.positions.get(pair);
    if (!pos) return null;
    if (pos.side === "long") {
      if (price <= pos.stopLoss) return "stop_loss";
      if (price >= pos.takeProfit) return "take_profit";
    } else {
      if (price >= pos.stopLoss) return "stop_loss";
      if (price <= pos.takeProfit) return "take_profit";
    }
    return null;
  }

  private _checkDailyReset(): void {
    const today = new Date().toDateString();
    if (today !== this.dailyDate) {
      logger.info("New trading day — resetting daily PnL (was $%.2f)", this.dailyPnl);
      this.dailyPnl = 0;
      this.circuitBreaker = false;
      this.dailyDate = today;
    }
  }

  get openPositions(): Map<string, Position> { return this.positions; }
  get dailyPnlUsd(): number { return this.dailyPnl; }
  get circuitBreakerOn(): boolean { return this.circuitBreaker; }

  summary() {
    return {
      openPositions: this.positions.size,
      dailyPnlUsd: parseFloat(this.dailyPnl.toFixed(2)),
      circuitBreaker: this.circuitBreaker,
      pairs: [...this.positions.keys()],
    };
  }
}
