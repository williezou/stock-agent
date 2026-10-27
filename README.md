# stock-agent

A-share stock scanner with multi-style rankings, Telegram notifications, and a menu-managed daily watchlist close report.

## Features
- A-share universe from Eastmoney
- Four strategy categories with Top 5 for each
- News + announcement signals
- Telegram notification with clickable links
- Weekday 15:30 Asia/Shanghai close reports for a dynamic watchlist, initially seeded with Yili and Sciyon Wisdom
- MA/MACD/RSI/KDJ/Bollinger, volume-price, support/resistance, catalysts, and conditional trade plans
- Telegram delivery includes a two-stock dashboard plus 30-day candlestick/volume charts with MA5/MA20, Bollinger bands, and support/resistance overlays
- Final daily-bar validation so holidays and incomplete intraday quotes are not pushed as closes
- Telegram menu for adding, removing, and listing up to 10 tracked stocks

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
TELEGRAM_CHAT_ID=YOUR_CHAT_ID
TELEGRAM_ALLOWED_USER_ID= # optional, recommended for group chats
TELEGRAM_WEBHOOK_SECRET=
DATABASE_URL=
PUBLIC_BASE_URL=https://your-service.example
HTTP_PROXY=   # optional
HTTPS_PROXY=  # optional
```

> `FINNHUB_API_KEY` is no longer used but can be kept empty.

## Run
```
node scanner.js
```

Preview the daily close report without sending Telegram messages:
```
npm run daily-close:dry-run
```

Run the Telegram task:
```
npm run daily-close
```

The GitHub Actions workflow in `.github/workflows/daily-close.yml` runs at 15:30 Asia/Shanghai on weekdays. Configure `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and the external PostgreSQL `DATABASE_URL` as repository secrets. The script sends nothing unless every tracked stock has a completed daily bar for the current China trading date.

## Telegram menu deployment

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

