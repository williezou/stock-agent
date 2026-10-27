# stock-agent（中文版）

基于东财数据的 A 股扫描器，支持四类策略（日内 / 短线 / 波段 / 中线），并可通过 Telegram 推送结果。项目还包含“伊利股份 + 科远智慧”每日收盘分析任务。

## 功能
- A 股股票池（过滤北交所/科创板/ST/次新）
- 四类策略各自 Top5
- 结合新闻 / 公告作为催化剂
- Telegram 推送（带新闻来源与链接）
- 每个 A 股交易日 15:30 生成伊利股份（600887）与科远智慧（002380）收盘报告
- 报告包含 MA、MACD、RSI、KDJ、布林带、量价、支撑压力、公告/催化与条件性交易计划
- Telegram 推送包含双股仪表盘，以及近 30 日 K 线、MA5/MA20、布林带、支撑压力和成交量图
- 用当日完整日 K 线二次确认交易日，非交易日不推送，避免把盘中价当收盘价

## 环境要求
- Node.js 18+

## 安装
```
npm install
```

## 配置
复制 `.env.example` 为 `.env`，并填写：
```
TELEGRAM_BOT_TOKEN=你的机器人token
TELEGRAM_CHAT_ID=你的chat_id
HTTP_PROXY=   # 可选
HTTPS_PROXY=  # 可选
NEWSNOW_BASE_URL= # 可选，默认 https://newsnow.busiyi.world
```

## 运行
```
node scanner.js
```

每日收盘任务试运行（只输出到终端，不发送 Telegram）：
```
npm run daily-close:dry-run
```

正式运行：
```
npm run daily-close
```

GitHub Actions 工作流 `.github/workflows/daily-close.yml` 会在工作日北京时间 15:30 触发。仓库需要配置现有的 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_CHAT_ID` Secrets；脚本会检查两只股票是否都有当天完整日 K，节假日不会发送。

## 测试
```
npm test
```

## 说明
- 数据来源为公开接口（非官方），格式可能变化。
- 公开行情接口不提供可核验的获利盘或机构成本；报告中的 20 日量价加权均价仅作代理参考，不会冒充筹码数据。
- 本项目仅用于研究与学习，不构成投资建议。

