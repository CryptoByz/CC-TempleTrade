import { initialize, getTicker, getActiveOrders, cancelAllOrders } from "@temple-digital-group/temple-canton-js";
import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();

const CONFIG = {
  pair:          "CC/USDCx",
  gridLevels:    2,
  gridStep:      0.0001,
  orderQty:      35,
  checkInterval: 60 * 60 * 1000,
  dryRun:        process.env.DRY_RUN !== "false",
  tgToken:       process.env.TELEGRAM_TOKEN || "",
  tgChatId:      process.env.TELEGRAM_CHAT_ID || "",
};

const logDir = "logs";
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logFile = fs.createWriteStream(path.join(logDir, "bot.log"), { flags: "a" });

function log(level: string, msg: string) {
  const line = `${new Date().toISOString()} | ${level.padEnd(5)} | ${msg}`;
  console.log(line);
  logFile.write(line + "\n");
}
const info  = (m: string) => log("INFO", m);
const error = (m: string) => log("ERROR", m);

async function tg(msg: string): Promise<void> {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id: CONFIG.tgChatId,
      text: msg,
    });
  } catch (e) {
    error(`TG mesaj hatasi: ${e}`);
  }
}

let botRunning = true;
let lastUpdateId = 0;

async function handleCommands(): Promise<void> {
  if (!CONFIG.tgToken) return;
  try {
    const r = await axios.get(`https://api.telegram.org/bot${CONFIG.tgToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`);
    const updates = r.data.result || [];
    for (const update of updates) {
      lastUpdateId = update.update_id;
      const text = update.message?.text?.trim().toLowerCase();
      const chatId = String(update.message?.chat?.id);
      if (chatId !== CONFIG.tgChatId) continue;

      if (text === "/stop") {
        botRunning = false;
        await tg("Bot durduruldu. Yeniden baslatmak icin /start gonder.");
        info("TG: Bot durduruldu.");
      } else if (text === "/start") {
        botRunning = true;
        await tg("Bot baslatildi.");
        info("TG: Bot baslatildi.");
        await updateGrid();
      } else if (text === "/status") {
        await sendStatus();
      } else if (text === "/dryrun") {
        CONFIG.dryRun = !CONFIG.dryRun;
        const modMsg = CONFIG.dryRun
          ? "DRY RUN modu ACIK. Emirler gercek degil."
          : "CANLI mod ACIK. Emirler gercek!";
        await tg(modMsg);
        info(`TG: Mod degistirildi -> ${CONFIG.dryRun ? "DRY RUN" : "CANLI"}`);
      }
    }
  } catch (e) {
    // polling hatasi sessizce gec
  }
}

async function sendStatus(): Promise<void> {
  try {
    const tickerData: any = await getTicker(CONFIG.pair);
    const price = tickerData?.ticker?.oracle_price ?? tickerData?.ticker?.last_price;
    const ordersData: any = await getActiveOrders({ symbol: CONFIG.pair, limit: 150 });
    const orders = ordersData?.orders ?? [];
    const buys  = orders.filter((o: any) => o.side === "buy"  || o.side === "Buy");
    const sells = orders.filter((o: any) => o.side === "sell" || o.side === "Sell");
    let msg = `CC-TempleTrade Durum\n`;
    msg += `Mod: ${CONFIG.dryRun ? "DRY RUN" : "CANLI"}\n`;
    msg += `Bot: ${botRunning ? "Calisiyor" : "Durduruldu"}\n\n`;
    msg += `Fiyat: ${price} USDCx\n\n`;
    msg += `Acik Emirler (${orders.length}):\n`;
    for (const o of buys)  msg += `  BUY  @ ${o.price}\n`;
    for (const o of sells) msg += `  SELL @ ${o.price}\n`;
    if (orders.length === 0) msg += `  Acik emir yok\n`;
    msg += `\nKomutlar: /start /stop /dryrun /status`;
    await tg(msg);
  } catch (e) {
    await tg(`Durum alinamadi: ${e}`);
  }
}

const appHttp = axios.create({ baseURL: "https://api.templedigitalgroup.com", timeout: 10_000 });

async function placeOrder(side: "buy" | "sell", price: number): Promise<void> {
  const priceStr = price.toFixed(4);
  if (CONFIG.dryRun) {
    info(`[DRY RUN] ${side.toUpperCase()} 35 CC @ ${priceStr}`);
    return;
  }
  await appHttp.post("/orders", {
    symbol: CONFIG.pair, side, type: "limit",
    quantity: CONFIG.orderQty.toString(), price: priceStr, post_only: true,
  });
  info(`Emir verildi: ${side.toUpperCase()} 35 CC @ ${priceStr}`);
}

async function placeGridOrders(oraclePrice: number): Promise<void> {
  info(`Oracle: ${oraclePrice} | Grid yerleştiriliyor...`);
  for (let i = 1; i <= CONFIG.gridLevels; i++) {
    await placeOrder("buy",  parseFloat((oraclePrice - i * CONFIG.gridStep).toFixed(4)));
    await placeOrder("sell", parseFloat((oraclePrice + i * CONFIG.gridStep).toFixed(4)));
  }
  info(`${CONFIG.gridLevels * 2} emir yerleştirildi.`);
}

let lastKnownOrders: any[] = [];

async function updateGrid(): Promise<void> {
  if (!botRunning) { info("Bot durduruldu, guncelleme atlandi."); return; }
  info("--------------------------------------------------");
  try {
    const tickerData: any = await getTicker(CONFIG.pair);
    const oraclePrice = tickerData?.ticker?.oracle_price ?? tickerData?.ticker?.last_price;
    if (!oraclePrice) throw new Error("Fiyat alinamadi: " + JSON.stringify(tickerData));
    info(`Fiyat: ${oraclePrice}`);

    const ordersData: any = await getActiveOrders({ symbol: CONFIG.pair, limit: 150 });
    const currentOrders = ordersData?.orders ?? [];
    info(`Aktif emir: ${currentOrders.length}`);

    const currentIds = new Set(currentOrders.map((o: any) => o.id || o.orderId || o.order_id));
    const filledOrders = lastKnownOrders.filter((o: any) => !currentIds.has(o.id || o.orderId || o.order_id));

    let tgMsg = `CC-TempleTrade Guncelleme\n`;
    tgMsg += `Fiyat: ${oraclePrice} USDCx\n`;
    tgMsg += `Mod: ${CONFIG.dryRun ? "DRY RUN" : "CANLI"}\n\n`;

    if (filledOrders.length > 0) {
      tgMsg += `Gerceklesen Emirler (${filledOrders.length}):\n`;
      for (const o of filledOrders) tgMsg += `  ${o.side?.toUpperCase()} @ ${o.price}\n`;
      tgMsg += "\n";
    }

    const expected = CONFIG.gridLevels * 2;
    if (currentOrders.length < expected) {
      info(`Eksik emir (${currentOrders.length}/${expected}) -> yeniden yerleştiriliyor`);
      if (!CONFIG.dryRun) await cancelAllOrders({ symbol: CONFIG.pair });
      else info("[DRY RUN] Tum emirler iptal edildi");
      await placeGridOrders(oraclePrice);
      tgMsg += `Grid Guncellendi:\n`;
      for (let i = 1; i <= CONFIG.gridLevels; i++) {
        tgMsg += `  BUY  @ ${(oraclePrice - i * CONFIG.gridStep).toFixed(4)}\n`;
        tgMsg += `  SELL @ ${(oraclePrice + i * CONFIG.gridStep).toFixed(4)}\n`;
      }
    } else {
      const prices = currentOrders.map((o: any) => parseFloat(o.price)).sort((a: number, b: number) => a - b);
      const midPrice = (prices[0] + prices[prices.length - 1]) / 2;
      const drift = Math.abs(midPrice - oraclePrice);
      if (drift > CONFIG.gridStep * 2) {
        info(`Fiyat kaydi ${drift.toFixed(4)} -> revize ediliyor`);
        if (!CONFIG.dryRun) await cancelAllOrders({ symbol: CONFIG.pair });
        else info("[DRY RUN] Tum emirler iptal edildi");
        await placeGridOrders(oraclePrice);
        tgMsg += `Grid Revize Edildi (sapma: ${drift.toFixed(4)})\n`;
        for (let i = 1; i <= CONFIG.gridLevels; i++) {
          tgMsg += `  BUY  @ ${(oraclePrice - i * CONFIG.gridStep).toFixed(4)}\n`;
          tgMsg += `  SELL @ ${(oraclePrice + i * CONFIG.gridStep).toFixed(4)}\n`;
        }
      } else {
        info(`Grid guncel. Sapma: ${drift.toFixed(4)}`);
        tgMsg += `Acik Emirler:\n`;
        const buys  = currentOrders.filter((o: any) => o.side === "buy"  || o.side === "Buy");
        const sells = currentOrders.filter((o: any) => o.side === "sell" || o.side === "Sell");
        for (const o of buys)  tgMsg += `  BUY  @ ${o.price}\n`;
        for (const o of sells) tgMsg += `  SELL @ ${o.price}\n`;
      }
    }

    lastKnownOrders = currentOrders;
    await tg(tgMsg);
  } catch (err) {
    error(`Hata: ${err}`);
    await tg(`Hata olustu: ${err}`);
  }
}

async function main(): Promise<void> {
  info("==================================================");
  info("  CC-TempleTrade -- Oracle Grid Bot v5");
  info(`  Parite: ${CONFIG.pair} | Adim: ${CONFIG.gridStep} | Miktar: ${CONFIG.orderQty} CC`);
  info(`  Mod: ${CONFIG.dryRun ? "DRY RUN" : "CANLI"}`);
  info("==================================================");

  await initialize({
    NETWORK:      "mainnet",
    API_EMAIL:    process.env.TEMPLE_EMAIL as string,
    API_PASSWORD: process.env.TEMPLE_PASSWORD as string,
  });
  info("SDK baslatildi.");

  await tg(`CC-TempleTrade baslatildi\nMod: ${CONFIG.dryRun ? "DRY RUN" : "CANLI"}\nKomutlar: /status /stop /start /dryrun`);

  await updateGrid();
  setInterval(() => updateGrid(), CONFIG.checkInterval);
  setInterval(() => handleCommands(), 3000);

  process.on("SIGINT",  async () => { await tg("Bot kapatildi."); if (!CONFIG.dryRun) await cancelAllOrders({ symbol: CONFIG.pair }); process.exit(0); });
  process.on("SIGTERM", async () => { await tg("Bot kapatildi."); if (!CONFIG.dryRun) await cancelAllOrders({ symbol: CONFIG.pair }); process.exit(0); });
}

main().catch((err) => { error(`Kritik hata: ${err}`); process.exit(1); });
