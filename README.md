# stock-agent

A-share stock scanner with multi-style rankings, Telegram notifications, and a menu-managed daily watchlist close report.

## Features
- A-share universe from Eastmoney
- Four strategy categories with Top 5 for each
- News + announcement signals
- Telegram notification with clickable links
- Weekday 15:30 Asia/Shanghai close reports for a dynamic watchlist, initially seeded with Yili and Sciyon Wisdom
- Dragon-Tiger list (龙虎榜) pushed separately once the exchanges finish publishing it in the evening (checked 17:30-20:30): a Chinese chart of the top 10 net buyers / top 5 net sellers, with stock-name buttons below it that reply with that stock's broker-seat table; toggle with `/longhu`
- After the Dragon-Tiger push, a "hot money" push: the day's seats aggregated by brokerage branch (excluding institutional and Stock Connect seats), the top 10 net buyers with the stocks they bought, and each branch's past-year record (share of buys followed by a rise 3 days later, average move, times listed; Eastmoney statistics), marked 🏆 at ≥60% over ≥20 listings; shares the `/longhu` toggle
- Intraday fund-flow alerts (default tail session 14:30-15:00): polls both ends of Eastmoney's main-force net inflow ranking (100 each) every minute, falling back to Sina Finance (and re-taking the baseline) when Eastmoney is unavailable, and pushes stocks whose net inflow changed by at least 50M CNY and 2% of the day's turnover since the window began; watchlist stocks are starred, windows are configurable, toggle with `/flow`. Main-force inflow is the data vendor's estimate, not official exchange data; the push names the source
- Close reports are stored per date and stock, so subscribers tracking the same stock on the same day reuse one report instead of refetching quotes and news; fund-flow push records and monitor state (restored after a restart) and sent admin alerts (no repeats after a restart) are stored too. All of these, like the daily K-line cache, are kept for 7 days and pruned daily by the scheduler
- Intraday volume-spike alerts (default 9:30-11:30 and 13:00-14:57): a full-market snapshot every minute (Shanghai from the SSE's official quotes in one request; Shenzhen has no bulk real-time exchange feed, so Sina Finance, about 30 pages), flagging stocks that traded at least 50M CNY and moved at least 2 percentage points in the last 5 minutes and pushing them in a batch every 10 minutes (plus once at the end of each window), once per stock and direction per day; toggle with `/spike`
- Daily summary page (enabled by `DAILY_PAGE_BUCKET` and `DAILY_PAGE_SECRET`): the watchlist close report (overview table plus each stock's K-line, trade plan and catalyst, with indicators collapsible), an intraday recap (the day's volume-spike and fund-flow alerts merged into lists), the Dragon-Tiger list and hot-money moves go into one page per user per day, hosted on GCS under a token derived from the user and date. Only two messages are pushed per day: the close summary with a page button, and an "updated" notice once the Dragon-Tiger list and hot money are on the page. If writing the page fails, that delivery falls back to the per-image pushes
- Stock names in pushes open the quote app each subscriber picks with `/app` (Eastmoney, Xueqiu or China Merchants Securities; Eastmoney by default, via an iOS universal link straight into the app; China Merchants Securities via its share page, which hands off to the app's stock page and leaves that page open; Tonghuashun links only reach its mobile site or app home, so it is not offered); codes can be tapped to copy
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
IPV6_ONLY=false # optional; true on IPv6-only hosts: Eastmoney quotes use IPv6-capable numbered push2 nodes, Tencent uses its IPv6 endpoint, Tonghuashun (no IPv6) is skipped, so K-lines fall back to CLS (complete fields) and then Tencent
FUND_FLOW_WINDOWS=尾盘@14:30-15:00 # optional; intraday fund-flow alert windows as label@HH:MM-HH:MM, comma-separated (e.g. add 开盘@09:30-10:00)
FUND_FLOW_POLL_MINUTES=1 # optional
FUND_FLOW_MIN_AMOUNT_WAN=5000 # optional; minimum change in main-force net inflow within the window (10k CNY)
FUND_FLOW_MIN_RATIO_PCT=2 # optional; the same change as % of the day's turnover
VOLUME_SPIKE_WINDOWS=上午@09:30-11:30,下午@13:00-14:57 # optional; volume-spike alert windows
VOLUME_SPIKE_LOOKBACK_MINUTES=5 # optional
VOLUME_SPIKE_MIN_AMOUNT_WAN=5000 # optional; turnover within the lookback (10k CNY)
VOLUME_SPIKE_MIN_CHANGE_PCT=2 # optional; change in percent change within the lookback (percentage points)
VOLUME_SPIKE_PUSH_MINUTES=10 # optional; spikes are batched and pushed every N minutes
DAILY_PAGE_BUCKET=your-bucket # optional; public GCS bucket for the daily summary page
DAILY_PAGE_SECRET=long-random-string # optional; derives the unguessable per-user page token
```

> `FINNHUB_API_KEY` is no longer used but can be kept empty.

## Project structure
```
bin/               entry points (bot-poller, bot-server, scheduler, scan, daily-close, ...)
src/config.js      all environment variables
src/lib/           HTTP client/proxy, retry, concurrency pool, rate limiter
src/gateways/      Telegram Bot API client
src/models/        data: Postgres repositories, stock codes, market data (Eastmoney → Tonghuashun → CLS → Tencent), news, Dragon-Tiger list, trading calendar
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

Each person starts a private subscription with `/start INVITE_CODE` when `BOT_INVITE_CODE` is configured, or plain `/start` when `BOT_OPEN_REGISTRATION=true`. With neither set, only the admin (`TELEGRAM_CHAT_ID`) can register. The admin bypasses the invite code and `MAX_SUBSCRIBERS`; group chats are ignored. Watchlists and delivery state are isolated by Telegram chat. The scheduler analyzes the union of symbols once, then sends each subscriber only their own report. `/stop` pauses delivery without deleting the watchlist. `/longhu` (or `/longhu on|off`) toggles the evening Dragon-Tiger list and hot-money pushes, which are on by default. `/flow` (or `/flow on|off`) toggles the tail-session fund-flow alerts and `/spike` (or `/spike on|off`) the intraday volume-spike alerts, both on by default. `/app` (buttons, or `/app 雪球`) picks which quote app stock names open in pushes, replies and the daily page. The admin-only `/users` (shown only in the admin's menu) lists subscribers: active/inactive/banned counts, a watchlist summary, and each subscriber's ID, watchlist, disabled pushes and sign-up date. The admin-only `/ban <ID or @username>` and `/unban …` block and unblock a subscriber: a banned subscriber receives no pushes and gets no reply to any message, including `/start`; the watchlist is kept. Tapping a stock-name button under the Dragon-Tiger chart replies with that stock's broker-seat table (the same stock is not re-sent within 60 seconds).

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

