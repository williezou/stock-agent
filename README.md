# stock-agent

A-share stock scanner with multi-style rankings, Telegram notifications, and a menu-managed daily watchlist close report.

## Features
- A-share universe from Eastmoney
- Four strategy categories with Top 5 for each
- News + announcement signals
- Telegram notification with clickable links
- Weekday 15:30 Asia/Shanghai close reports for a dynamic watchlist, initially seeded with Yili and Sciyon Wisdom
- Dragon-Tiger list (龙虎榜) pushed separately once the exchanges finish publishing it in the evening (checked 17:30-20:30): a Chinese chart of the top 10 net buyers / top 5 net sellers, with stock-name buttons below it that reply with that stock's broker-seat table; toggle with `/longhu`
- Intraday fund-flow alerts (default tail session 14:30-15:00): polls both ends of Eastmoney's main-force net inflow ranking (100 each) every minute and pushes stocks whose net inflow changed by at least 50M CNY and 2% of the day's turnover since the window began; watchlist stocks are starred, windows are configurable, toggle with `/flow`. Main-force inflow is Eastmoney's estimate, not official exchange data
- Stock names in pushes open the stock page in the Eastmoney app directly (iOS universal link); codes can be tapped to copy
- MA/MACD/RSI/KDJ/Bollinger, volume-price, support/resistance, catalysts, and conditional trade plans
- Telegram delivery includes a two-stock dashboard plus 30-day candlestick/volume charts with MA5/MA20, Bollinger bands, and support/resistance overlays
- Final daily-bar validation so holidays and incomplete intraday quotes are not pushed as closes
- Private multi-user Telegram subscriptions, each with an independent watchlist of up to 10 stocks

## Requirements
- Node.js 18+

## Install
```
npm install
```

## Configure
Create a `.env` file:
```
FINNHUB_API_KEY=
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
TELEGRAM_CHAT_ID=ADMIN_CHAT_ID
BOT_INVITE_CODE= # optional; required for /start when set
BOT_OPEN_REGISTRATION=false # true allows /start without an invite code
MAX_SUBSCRIBERS=50
TELEGRAM_WEBHOOK_SECRET=
DATABASE_URL=
PUBLIC_BASE_URL=https://your-service.example
HTTP_PROXY=   # optional
HTTPS_PROXY=  # optional
IPV6_ONLY=false # optional; true on IPv6-only hosts: Eastmoney quotes use IPv6-capable numbered push2 nodes, Tencent uses its IPv6 endpoint, Tonghuashun (no IPv6) is skipped
FUND_FLOW_WINDOWS=尾盘@14:30-15:00 # optional; intraday fund-flow alert windows as label@HH:MM-HH:MM, comma-separated (e.g. add 开盘@09:30-10:00)
FUND_FLOW_POLL_MINUTES=1 # optional
FUND_FLOW_MIN_AMOUNT_WAN=5000 # optional; minimum change in main-force net inflow within the window (10k CNY)
FUND_FLOW_MIN_RATIO_PCT=2 # optional; the same change as % of the day's turnover
```

> `FINNHUB_API_KEY` is no longer used but can be kept empty.

## Project structure
```
bin/               entry points (bot-poller, bot-server, scheduler, scan, daily-close, ...)
src/config.js      all environment variables
src/lib/           HTTP client/proxy, retry, concurrency pool, rate limiter
src/gateways/      Telegram Bot API client
src/models/        data: Postgres repositories, stock codes, market data (Eastmoney → Tonghuashun → Tencent), news, Dragon-Tiger list, trading calendar
src/services/      business logic: technical analysis, screening, daily report, scan, report delivery, bot setup
src/views/         presentation: Telegram message text, bot replies, stock-name links (stock-link.js: names link to Eastmoney, codes copyable), PNG charts (Chinese charts use @napi-rs/canvas)
src/controllers/   input handling: bot commands, webhook HTTP, daily delivery scheduler
test/              mirrors src/
```

## Run
```
npm run scan            # A-share scan, sends to TELEGRAM_CHAT_ID (scheduled on GitHub Actions)
npm run scan:dry-run    # print only
```

Preview the daily close report without sending Telegram messages:
```
npm run daily-close:dry-run
```

Run the Telegram task:
```
npm run daily-close
```

The A-share scan runs on GitHub Actions (`scan.yml`, weekday schedule) so its heavy request volume does not get the local IP rate-limited; the stock list falls back from Eastmoney to Sina. `daily-close.yml` is a manual-only backup; close reports and the Dragon-Tiger list run from the local Docker scheduler to avoid duplicates. Configure `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and the external PostgreSQL `DATABASE_URL` as repository secrets. The script sends nothing unless every tracked stock has a completed daily bar for the current China trading date.

## Telegram menu deployment

### Local Docker deployment (recommended)

Local deployment uses Telegram long polling, so no public IP, domain, or HTTPS endpoint is required. Docker Compose runs a polling bot, a weekday scheduler (Asia/Shanghai: 15:30-18:00 close reports, 17:30-20:30 Dragon-Tiger list) with delayed retries, and a private PostgreSQL database:

```bash
docker compose up -d --build
docker compose run --rm bot npm run bot:menu
```

Use `docker compose ps` and `docker compose logs -f bot scheduler` to inspect the services. `docker compose down` keeps the database volume; adding `--volumes` removes it. The containers use `http://host.docker.internal:6152` as the default proxy; override `DOCKER_PROXY_URL` when needed. The image build also sends `npm ci` through that proxy (keep it running while building), installs a Chinese font (WenQuanYi Micro Hei) for the Dragon-Tiger charts, and fetches apt packages directly from the USTC mirror (override with `--build-arg APT_MIRROR=...`). Close reports and the Dragon-Tiger list are scheduled locally; the A-share scan is scheduled on GitHub Actions, so nothing is sent twice.

Each person starts a private subscription with `/start INVITE_CODE` when `BOT_INVITE_CODE` is configured, or plain `/start` when `BOT_OPEN_REGISTRATION=true`. With neither set, only the admin (`TELEGRAM_CHAT_ID`) can register. The admin bypasses the invite code and `MAX_SUBSCRIBERS`; group chats are ignored. Watchlists and delivery state are isolated by Telegram chat. The scheduler analyzes the union of symbols once, then sends each subscriber only their own report. `/stop` pauses delivery without deleting the watchlist. `/longhu` (or `/longhu on|off`) toggles the evening Dragon-Tiger list push, which is on by default. `/flow` (or `/flow on|off`) toggles the intraday fund-flow alerts, also on by default. Tapping a stock-name button under the Dragon-Tiger chart replies with that stock's broker-seat table (the same stock is not re-sent within 60 seconds).

### Render deployment (optional)

`render.yaml` provisions a Node webhook service and PostgreSQL for testing. After deployment, configure the Telegram credentials and webhook secret in Render. Render supplies `RENDER_EXTERNAL_URL`, so the service registers its Telegram webhook and commands automatically.

Outside Render, set the public service URL locally and run:

```
npm run telegram:configure
```

This registers the webhook and the `/add`, `/remove`, `/list`, and `/cancel` commands. The webhook service runs with `npm run bot` and exposes `/healthz`. Render's free web service and database plans are suitable for testing only; choose persistent, non-sleeping services for reliable operation.

## Test
```
npm test
```

## Notes
- Data sources are non-official public endpoints; response formats may change.
- Public data does not provide verifiable institutional cost or profitable-holder ratios. The report labels its 20-day volume-weighted close as a proxy only.
- This project is for research and education only. Do not use as investment advice.

