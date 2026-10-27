# stock-agent（中文版）

基于东财数据的 A 股扫描器，支持四类策略（日内 / 短线 / 波段 / 中线），并可通过 Telegram 推送结果。项目还包含可通过 Telegram 菜单维护的每日自选股收盘分析任务。

## 功能
- A 股股票池（过滤北交所/科创板/ST/次新）
- 四类策略各自 Top5
- 结合新闻 / 公告作为催化剂
- Telegram 推送（带新闻来源与链接）
- 每个 A 股交易日 15:30 生成自选股收盘报告；首次启动默认包含伊利股份（600887）与科远智慧（002380）
- 交易所收盘后傍晚发布龙虎榜，调度器在 17:30-20:30 检测到当日榜单发布完成后单独推送（净买入/净卖出排行），用户可用 `/longhu` 开关
- 报告包含 MA、MACD、RSI、KDJ、布林带、量价、支撑压力、公告/催化与条件性交易计划
- Telegram 推送包含双股仪表盘，以及近 30 日 K 线、MA5/MA20、布林带、支撑压力和成交量图
- 用当日完整日 K 线二次确认交易日，非交易日不推送，避免把盘中价当收盘价
- Telegram 支持多人私聊订阅；每个人可独立添加、删除和查看最多 10 只追踪股票

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
TELEGRAM_CHAT_ID=管理员的chat_id
BOT_INVITE_CODE=好友邀请码 # 可选；设置后需 /start 邀请码 注册
BOT_OPEN_REGISTRATION=false # 设为true时无需邀请码即可注册
MAX_SUBSCRIBERS=50
TELEGRAM_WEBHOOK_SECRET=至少16位随机字符串
DATABASE_URL=PostgreSQL连接地址
PUBLIC_BASE_URL=https://你的服务域名
HTTP_PROXY=   # 可选
HTTPS_PROXY=  # 可选
NEWSNOW_BASE_URL= # 可选，默认 https://newsnow.busiyi.world
```

## 目录结构
```
bin/               入口脚本（bot-poller、bot-server、scheduler、scan、daily-close 等）
src/config.js      集中读取全部环境变量
src/lib/           HTTP客户端/代理、重试、并发池、限流
src/gateways/      Telegram Bot API 客户端
src/models/        M：数据库仓储、股票代码、行情数据（东方财富→同花顺→腾讯）、新闻、龙虎榜、交易日历
src/services/      业务逻辑：技术分析、选股、每日收盘报告、A股扫描、报告推送、机器人配置
src/views/         V：Telegram消息文案、机器人回复、PNG图表
src/controllers/   C：机器人命令、Webhook HTTP、每日投递调度
test/              与 src/ 结构对应
```

## 运行
```
npm run scan            # A股扫描，推送给 TELEGRAM_CHAT_ID
npm run scan:dry-run    # 只输出到终端
```

每日收盘任务试运行（只输出到终端，不发送 Telegram）：
```
npm run daily-close:dry-run
```

正式运行：
```
npm run daily-close
```

GitHub Actions 工作流 `.github/workflows/daily-close.yml` 会在工作日北京时间 15:30 触发。仓库需要配置 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` 和 PostgreSQL 外部连接地址 `DATABASE_URL` Secrets；脚本会检查全部追踪股票是否都有当天完整日 K，节假日不会发送。

## Telegram 菜单与 Render 部署

### 本机 Docker 部署（推荐）

本机部署使用 Telegram 长轮询，不需要公网 IP、域名或 HTTPS。Docker Compose 会启动：

- `bot`：处理添加、删除和查看追踪股票
- `scheduler`：工作日北京时间 15:30 后生成每日收盘报告，行情未就绪时每 10 分钟重试；17:30-20:30 每 10 分钟检查龙虎榜，沪深两市都已上榜且数量两次不变即视为发布完成并推送，20:20 后有数据即推送，交易日仍无数据会提醒管理员
- `postgres`：持久化自选股与任务执行状态，数据库端口不会暴露到宿主机

其他用户与机器人私聊后建立自己的订阅：配置了 `BOT_INVITE_CODE` 时使用 `/start 邀请码`；设置 `BOT_OPEN_REGISTRATION=true` 时直接发送 `/start`；两者都未设置时仅管理员（`TELEGRAM_CHAT_ID`）可注册。管理员不受邀请码和 `MAX_SUBSCRIBERS` 限制；群聊消息会被忽略。每个人只能看到和修改自己的自选股；相同股票会合并抓取和分析，再按用户分别生成报告。发送 `/stop` 可暂停推送但保留列表。

确保 `.env` 中已有 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`，然后执行：

```bash
docker compose up -d --build
docker compose run --rm bot npm run bot:menu
```

常用运维命令：

```bash
docker compose ps
docker compose logs -f bot scheduler
docker compose restart bot scheduler
docker compose down             # 保留数据库卷
docker compose down --volumes   # 同时删除本地数据库数据
```

如果宿主机通过代理访问 Telegram，默认会使用 `http://host.docker.internal:6152`；可通过 `.env` 中的 `DOCKER_PROXY_URL` 修改。定时任务由本机容器负责，GitHub Actions 工作流仅保留手动触发，避免重复推送。

### Render 部署（可选）

项目根目录的 `render.yaml` 可创建 Node webhook Web Service 和 PostgreSQL。部署后设置以下 Render 环境变量：

```
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
BOT_INVITE_CODE # 可选
BOT_OPEN_REGISTRATION # 可选，默认false
MAX_SUBSCRIBERS # 可选，默认50
TELEGRAM_WEBHOOK_SECRET
```

Web Service 使用 `npm run bot` 启动，健康检查路径为 `/healthz`。Render 会提供 `RENDER_EXTERNAL_URL`，服务启动后会自动注册 Telegram webhook 和命令，无需手动复制生成的 webhook 密钥。

非 Render 环境可配置同样的变量和 `PUBLIC_BASE_URL`，手动执行：

```
npm run telegram:configure
```

该命令会注册 `/telegram/webhook`、设置 `/add`、`/remove`、`/list` 等命令，并向指定会话发送操作菜单。

菜单操作：

- `/add 600519` 添加股票（只发 `/add` 会提示输入代码）
- `/remove 600519` 删除股票（只发 `/remove` 会列出可删除的股票）
- `/list` 查看追踪列表
- `/cancel` 取消当前输入
- `/longhu` 开启/关闭龙虎榜推送（也可 `/longhu on`、`/longhu off`），默认开启
- `/stop` 暂停个人每日推送，`/start` 可恢复

Render 免费 Web Service 会在空闲后休眠，免费 PostgreSQL 也只适合测试；长期稳定使用应选择持久化且不休眠的方案。

## 测试
```
npm test
```

## 说明
- 数据来源为公开接口（非官方），格式可能变化。
- 公开行情接口不提供可核验的获利盘或机构成本；报告中的 20 日量价加权均价仅作代理参考，不会冒充筹码数据。
- 本项目仅用于研究与学习，不构成投资建议。

