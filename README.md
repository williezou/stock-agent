# stock-agent

A-share stock scanner with multi-style rankings (intraday / short / swing / mid) using Eastmoney data, plus optional Telegram notifications.

## Features
- A-share universe from Eastmoney
- Four strategy categories with Top 5 for each
- News + announcement signals
- Telegram notification with clickable links

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

## Notes
- Data sources are non-official public endpoints; response formats may change.
- This project is for research and education only. Do not use as investment advice.

