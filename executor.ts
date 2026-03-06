import { v4 as uuid } from "uuid";
import { TempleClient } from "../api/client";
import { RiskManager } from "../risk/manager";
import { config } from "../../config";
import { logger } from "../logger";

export class OrderExecutor {
  constructor(
    private api: TempleClient,
    private risk: RiskManager,
    private dryRun = config.dryRun
  ) {
    if (dryRun) logger.warn("⚠️  DRY RUN MODE — no real orders will be sent to Temple");
  }

  async openLong(pair: string, price: number): Promise<string | null> {
    return this._openPosition(pair, "buy", "long", price);
  }

  async openShort(pair: string, price: number): Promise<string | null> {
    return this._openPosition(pair, "sell", "short", price);
  }

  async closePosition(pair: string, price: number): Promise<void> {
    const pos = this.risk.openPositions.get(pair);
    if (!pos) return;
    const side = pos.side === "long" ? "sell" : "buy";
    const limitPrice = this.risk.computeLimitPrice(side, price);
    const clientId = `close-${pair.replace("/", "")}-${uuid().slice(0, 8)}`;

    await this._placeOrder({ pair, side, qty: pos.qty, price: limitPrice, clientId, reason: "exit" });
    this.risk.closePosition(pair, price);
  }

  async cancelAll(pair?: string): Promise<void> {
    if (this.dryRun) {
      logger.info("[DRY RUN] Would cancel all orders%s", pair ? ` for ${pair}` : "");
      return;
    }
    try {
      await this.api.cancelAllOrders(pair);
      logger.info("Cancelled all orders%s", pair ? ` for ${pair}` : "");
    } catch (e) {
      logger.error("cancelAll failed: %s", e);
    }
  }

  private async _openPosition(
    pair: string,
    side: "buy" | "sell",
    posSide: "long" | "short",
    price: number
  ): Promise<string | null> {
    const { allowed, reason } = this.risk.canTrade(pair, posSide);
    if (!allowed) {
      logger.warn("Trade blocked [%s]: %s", pair, reason);
      return null;
    }

    const qty = this.risk.computeQty(price);
    const limitPrice = this.risk.computeLimitPrice(side, price);
    const clientId = `open-${pair.replace("/", "")}-${uuid().slice(0, 8)}`;

    const order = await this._placeOrder({
      pair, side, qty, price: limitPrice, clientId, reason: `open ${posSide}`,
    });

    if (order) {
      const { stop, take } = this.risk.computeStopTake(posSide, limitPrice);
      this.risk.openPosition({
        pair, side: posSide, entryPrice: limitPrice, qty,
        stopLoss: stop, takeProfit: take,
        entryTime: Date.now(),
        orderId: (order as { orderId?: string }).orderId ?? clientId,
      });
      return (order as { orderId?: string }).orderId ?? clientId;
    }
    return null;
  }

  private async _placeOrder(opts: {
    pair: string;
    side: "buy" | "sell";
    qty: number;
    price: number;
    clientId: string;
    reason?: string;
  }): Promise<object | null> {
    const { pair, side, qty, price, clientId, reason } = opts;

    if (this.dryRun) {
      logger.info(
        "[DRY RUN] %s | %s %s qty=%.6f @ %.4f | %s",
        clientId, side.toUpperCase(), pair, qty, price, reason ?? ""
      );
      return { orderId: `DRY-${clientId}`, status: "simulated" };
    }

    try {
      const resp = await this.api.placeOrder({
        symbol: pair,
        side,
        type: "limit",
        quantity: qty.toString(),
        price: price.toString(),
        clientOrderId: clientId,
        postOnly: true,
      });
      logger.info(
        "Order placed ✓ | %s %s qty=%.6f @ %.4f | id=%s | %s",
        side.toUpperCase(), pair, qty, price, resp.orderId, reason ?? ""
      );
      return resp;
    } catch (err) {
      logger.error("Order placement failed [%s %s]: %s", side, pair, err);
      return null;
    }
  }
}
