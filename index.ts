import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();

const CONFIG = {
  email:         process.env.TEMPLE_EMAIL!,
  password:      process.env.TEMPLE_PASSWORD!,
  baseUrl:       "https://api.templedigitalgroup.com",
  pair:          "CC-USDCx",
  gridLevels:    5,
  gridStep:      0.0001,
  orderQty:      35,
  checkInterval: 60 * 60 * 1000,
  dryRun:        process.env.DRY_RUN !== "false",
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
const warn  = (m: string) => log("WARN", m);
const error = (m: string) => log("ERROR", m);

let accessToken  = "";
let refreshToken = "";

const http = axios.create({ baseURL: CONFIG.baseUrl, timeout: 10_000 });
http.interceptors.request.use((req) => {
  if (accessToken) req.headers["Authorization"] = `Bearer ${accessToken}`;
  return req;
});

async function login(): Promise<void> {
  info("Temple'a giriş yapılıyor...");
  const { data } = await http.post("/auth/login", {
    email:    CONFIG.email,
    password: CONFIG.password,
  });
  accessToken  = data.accessToken;
  refreshToken = data.refreshToken;
  info(`Giriş başarılı. Token süresi: ${data.expiresIn}s`);
  setTimeout(async () => {
    try {
      const r = await http.post("/auth/refresh-token", { refreshToken });
      accessToken  = r.data.accessToken;
      refreshToken = r.data.refreshToken ?? refreshToken;
      info("Token yenilendi.");
    } catch {
      warn("Token yenileme başarısız, yeniden giriş yapılıyor...");
      await login();
    }
  }, Math.max((data.expiresIn - 60) * 1000, 5000));
}

async function getOraclePrice(): Promise<number> {
  const { data } = await http.get(`/market/ticker/${CONFIG.pair}`);
  const price = data.oraclePrice ?? data.oracle_price ?? data.lastPrice ?? data.last_price;
  if (!price) throw new Error(`Oracle fiyatı bulunamadı: ${JSON.stringify(data)}`);
  return parseFloat(price);
}

async function getActiveOrders(): Promise<{ orderId: string; price: number; side: string }[]> {
  const { data } = await http.get("/orders/active", { params: { symbol: CONFIG.pair } });
  return (Array.isArray(data) ? data : data.orders ?? []).map((o: Record<string, unknown>) => ({
    orderId: o.orderId ?? o.id,
    price:   parseFloat(String(o.price)),
    side:    o.side,
  }));
}

async function cancelAllOrders(): Promise<void> {
  if (CONFIG.dryRun) { info("[DRY RUN] Tüm emirler iptal edildi (simülasyon)"); return; }
  await http.post("/orders/cancel-all", { symbol: CONFIG.pair });
  info("Tüm emirler iptal edildi.");
}

async function placeOrder(side: "buy" | "sell", price: number): Promise<void> {
  const priceStr = price.toFixed(4);
  if (CONFIG.dryRun) { info(`[DRY RUN] ${side.toUpperCase()} 35 CC @ ${priceStr}`); return; }
  await http.post("/orders", {
    symbol: CONFIG.pair, side, type: "limit",
    quantity: CONFIG.orderQty.toString(), price: priceStr, postOnly: true,
  });
  info(`Emir verildi: ${side.toUpperCase()} 35 CC @ ${priceStr}`);
}

async function placeGridOrders(oraclePrice: number): Promise<void> {
  info(`Oracle: ${oraclePrice} | Grid yerleştiriliyor...`);
  const promises: Promise<void>[] = [];
  for (let i = 1; i <= CONFIG.gridLevels; i++) {
    const buyPrice  = parseFloat((oraclePrice - i * CONFIG.gridStep).toFixed(4));
    const sellPrice = parseFloat((oraclePrice + i * CONFIG.gridStep).toFixed(4));
    promises.push(placeOrder("buy",  buyPrice));
    promises.push(placeOrder("sell", sellPrice));
  }
  await Promise.all(promises);
  info(`${CONFIG.gridLevels * 2} emir yerleştirildi.`);
}

async function updateGrid(): Promise<void> {
  info("─".repeat(50));
  try {
    const oraclePrice  = await getOraclePrice();
    const activeOrders = await getActiveOrders();
    info(`Oracle: ${oraclePrice} | Aktif emir: ${activeOrders.length}`);
    const expected = CONFIG.gridLevels * 2;
    if (activeOrders.length < expected) {
      info(`Eksik emir (${activeOrders.length}/${expected}) → yeniden yerleştiriliyor`);
      await cancelAllOrders();
      await placeGridOrders(oraclePrice);
    } else {
      const prices    = activeOrders.map(o => o.price).sort((a, b) => a - b);
      const midPrice  = (prices[0] + prices[prices.length - 1]) / 2;
      const drift     = Math.abs(midPrice - oraclePrice);
      const threshold = CONFIG.gridStep * 2;
      if (drift > threshold) {
        info(`Fiyat kaydı ${drift.toFixed(4)} > ${threshold} → revize ediliyor`);
        await cancelAllOrders();
        await placeGridOrders(oraclePrice);
      } else {
        info(`Grid güncel. Sapma: ${drift.toFixed(4)}`);
      }
    }
  } catch (err) {
    error(`Hata: ${err}`);
  }
}

async function main(): Promise<void> {
  info("═".repeat(50));
  info("  CC-TempleTrade — Oracle Grid Bot");
  info(`  Parite: ${CONFIG.pair} | Adım: ${CONFIG.gridStep} | Miktar: ${CONFIG.orderQty} CC`);
  info(`  Mod: ${CONFIG.dryRun ? "DRY RUN" : "CANLI"}`);
  info("═".repeat(50));
  await login();
  await updateGrid();
  setInterval(() => updateGrid(), CONFIG.checkInterval);
  process.on("SIGINT",  async () => { await cancelAllOrders(); process.exit(0); });
  process.on("SIGTERM", async () => { await cancelAllOrders(); process.exit(0); });
}

main().catch((err) => { error(`Kritik hata: ${err}`); process.exit(1); });
