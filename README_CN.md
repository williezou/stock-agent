# stock-agent（中文版）

基于东财数据的 A 股扫描器，支持四类策略（日内 / 短线 / 波段 / 中线），并可通过 Telegram 推送结果。

## 功能
- A 股股票池（过滤北交所/科创板/ST/次新）
- 四类策略各自 Top5
- 结合新闻 / 公告作为催化剂
- Telegram 推送（带新闻来源与链接）

## 环境要求
- Node.js 18+

## 安装
```
npm install
```

## 配置
在项目根目录创建 `.env`：
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

## 说明
- 数据来源为公开接口（非官方），格式可能变化。
- 本项目仅用于研究与学习，不构成投资建议。

