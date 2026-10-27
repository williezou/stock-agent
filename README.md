# stock-agent

A-share stock scanner with multi-style rankings (intraday / short / swing / mid) using Eastmoney data, plus optional Telegram notifications and a daily close report for Yili and Sciyon Wisdom.

## Features
- A-share universe from Eastmoney
- Four strategy categories with Top 5 for each
- News + announcement signals
- Telegram notification with clickable links
- Weekday 15:30 Asia/Shanghai close report for Yili (600887) and Sciyon Wisdom (002380)
- MA/MACD/RSI/KDJ/Bollinger, volume-price, support/resistance, catalysts, and conditional trade plans
- Telegram delivery includes a two-stock dashboard plus 30-day candlestick/volume charts with MA5/MA20, Bollinger bands, and support/resistance overlays
- Final daily-bar validation so holidays and incomplete intraday quotes are not pushed as closes

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

The GitHub Actions workflow in `.github/workflows/daily-close.yml` runs at 15:30 Asia/Shanghai on weekdays. Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as repository secrets. The script sends nothing unless both stocks have a completed daily bar for the current China trading date.

## Test
```
npm test
```

## Notes
- Data sources are non-official public endpoints; response formats may change.
- Public data does not provide verifiable institutional cost or profitable-holder ratios. The report labels its 20-day volume-weighted close as a proxy only.
- This project is for research and education only. Do not use as investment advice.

