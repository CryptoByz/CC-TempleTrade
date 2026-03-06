# Temple Digital Group — Trading Bot v2
### Canton Network | TypeScript | Official API

Production-ready algorithmic trading bot using **Temple Digital Group's official API** (`api.templedigitalgroup.com`). Built with the real endpoints documented at `apidocs.templedigitalgroup.com`.

---

## Architecture

```
temple-bot-v2/
│
├── src/
│   ├── index.ts              ← Entry point
│   ├── bot.ts                ← Main orchestrator
│   ├── logger.ts             ← Winston logger
│   │
│   ├── api/
│   │   └── client.ts         ← Temple REST + WebSocket client (official endpoints)
│   │
│   ├── strategy/
│   │   └── ma.ts             ← MA Crossover + RSI + Volume filter
│   │
│   ├── risk/
│   │   └── manager.ts        ← Position sizing, SL/TP, circuit breaker
│   │
│   └── core/
│       └── executor.ts       ← Order placement + dry-run mode
│
├── config/
│   └── index.ts              ← Centralised config from .env
│
├── .env.example              ← Environment template
├── package.json
└── tsconfig.json
```

---

## Temple API Endpoints Used

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/auth/login` | Email/password → JWT |
| `POST` | `/auth/refresh-token` | Refresh access token |
| `GET` | `/market/ticker/:symbol` | Live ticker |
| `GET` | `/market/orderbook/:symbol` | Order book depth |
| `GET` | `/market/candles/:symbol` | OHLCV candles |
| `GET` | `/market/recent-trades/:symbol` | Recent trades |
| `GET` | `/market/symbol-config/:symbol` | Min qty, tick size |
| `GET` | `/orders/active` | Open orders |
| `POST` | `/orders` | Place order |
| `POST` | `/orders/cancel` | Cancel order |
| `POST` | `/orders/cancel-all` | Cancel all |

WebSocket channels: `ticker`, `candle`, `orders`, `fills`

**SDK Alternatives:**
- `@temple-digital-group/temple-canton-js` — Official Canton JS SDK
- `@fivenorth/loop-sdk` — Non-custodial wallet trading

---

## Setup

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# → Fill in TEMPLE_EMAIL and TEMPLE_PASSWORD

# 3. Run (dry-run by default — safe!)
npm run dev

# 4. Go live when ready
# In .env: set DRY_RUN=false
npm start
```

---

## Strategy

**Moving Average Crossover (EMA 9/21)**

| Condition | Signal |
|-----------|--------|
| EMA(9) crosses above EMA(21) + volume ≥ 1.2× avg + RSI < 65 | **BUY** |
| EMA(9) crosses below EMA(21) + volume ≥ 1.2× avg + RSI > 35 | **SELL** |
| All other conditions | **HOLD** |

---

## Risk Controls

| Parameter | Default |
|-----------|---------|
| Order size | $1,000 |
| Max total exposure | $50,000 |
| Stop loss | 2% |
| Take profit | 4% |
| Daily loss circuit breaker | $2,000 |

---

## Assets on Temple (Canton Network)

- `BTC-USDCx` — Bitcoin quoted in Canton USDCx stablecoin
- `ETH-USDCx` — Ethereum quoted in Canton USDCx stablecoin
- Tokenized equities & commodities (coming 2026)

---

> **Note:** Temple is an institutional, permissioned venue on Canton Network. You need an approved account at [app.templedigitalgroup.com](https://app.templedigitalgroup.com) to trade live. Always run in `DRY_RUN=true` mode first.
