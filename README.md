# CC-TempleTrade — Oracle Grid Bot

Temple Digital Group üzerinde CC/USDCx paritesi için otomatik grid trading botu.

## Nasıl Çalışır?

Bot, oracle fiyatı etrafına simetrik alış/satış emirleri açar. Her saat başı fiyatı kontrol eder, gerekirse grid'i yeniden düzenler. Telegram üzerinden izlenir ve yönetilir.

**Örnek (oracle fiyat: 0.1496):**
- BUY  @ 0.1495
- SELL @ 0.1497
- BUY  @ 0.1494
- SELL @ 0.1498

## Gereksinimler

- Node.js v18+
- npm
- Temple Digital Group hesabı (KYC onaylı)
- Telegram botu (BotFather'dan alınır)

## Kurulum

### 1. Repoyu klonla
```bash
git clone https://github.com/CryptoByz/CC-TempleTrade.git
cd CC-TempleTrade
```

### 2. Bağımlılıkları kur
```bash
npm install
```

### 3. .env dosyasını oluştur
```bash
cp .env.example .env
nano .env
```

`.env` içine kendi bilgilerini gir:
```
TEMPLE_EMAIL=senin@email.com
TEMPLE_PASSWORD=sifren
DRY_RUN=true
TELEGRAM_TOKEN=botfather_dan_alinan_token
TELEGRAM_CHAT_ID=telegram_chat_id
```

> **Telegram Chat ID nasıl bulunur?**
> Telegram'da `@userinfobot`'a `/start` yaz, Chat ID'ni verir.

### 4. Botu başlat
```bash
npx ts-node index.ts
```

## Ayarlar

| Değişken | Açıklama | Varsayılan |
|----------|----------|------------|
| `TEMPLE_EMAIL` | Temple hesap emaili | - |
| `TEMPLE_PASSWORD` | Temple hesap şifresi | - |
| `DRY_RUN` | `true` = test modu, `false` = canlı | `true` |
| `TELEGRAM_TOKEN` | Telegram bot token | - |
| `TELEGRAM_CHAT_ID` | Telegram chat ID | - |

## Grid Parametreleri

`index.ts` dosyasında `CONFIG` bloğundan değiştirilebilir:
```typescript
const CONFIG = {
  pair:          "CC/USDCx",   // İşlem paritesi
  gridLevels:    2,             // Her yanda kaç emir (max 2, Temple limiti 5 emir)
  gridStep:      0.0001,        // Emirler arası fiyat farkı
  orderQty:      35,            // Her emirde kaç CC
  checkInterval: 60 * 60 * 1000 // Kontrol sıklığı (ms) — şu an 1 saat
};
```

## Canlıya Geçiş

Test modundan çıkmak için `.env` dosyasında:
```
DRY_RUN=false
```

## Telegram Komutları

| Komut | Açıklama |
|-------|----------|
| `/status` | Anlık fiyat ve açık emirleri göster |
| `/stop` | Botu durdur |
| `/start` | Botu başlat |

## Notlar

- Temple hesabında maksimum 5 limit emir açılabilir
- Bot kapatılırken (`CTRL+C`) tüm emirler otomatik iptal edilir
- `.env` dosyasını asla paylaşma veya GitHub'a yükleme
