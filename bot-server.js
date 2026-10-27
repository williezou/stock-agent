require("dotenv").config();

const crypto = require("node:crypto");
const http = require("node:http");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { createBotController } = require("./bot-service");
const { createMarketService } = require("./market");
const { DEFAULT_TARGETS } = require("./stocks");
const { answerCallbackQuery, sendTelegramTo } = require("./telegram");
const { configureTelegramWebhook } = require("./telegram-setup");
const { createWatchlistStore } = require("./watchlist-store");

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;

function requireConfiguration() {
    const missing = [
        ["TELEGRAM_BOT_TOKEN", process.env.TELEGRAM_BOT_TOKEN],
        ["DATABASE_URL", process.env.DATABASE_URL],
        ["TELEGRAM_WEBHOOK_SECRET", WEBHOOK_SECRET],
        ["TELEGRAM_CHAT_ID", ADMIN_CHAT_ID]
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`缺少配置：${missing.join("、")}`);
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(WEBHOOK_SECRET)) {
        throw new Error("TELEGRAM_WEBHOOK_SECRET需为16-256位字母、数字、下划线或连字符");
    }
}

function secureEqual(actual, expected) {
    const a = Buffer.from(String(actual || ""));
    const b = Buffer.from(String(expected || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createHttpClient() {
    if (!PROXY_URL) return axios.create({ timeout: 25000 });
    const agent = new HttpsProxyAgent(PROXY_URL);
    return axios.create({ httpAgent: agent, httpsAgent: agent, proxy: false, timeout: 25000 });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestWithRetry(fn, retries = 3) {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (error) {
            attempt++;
            if (attempt > retries) throw error;
            await delay(400 * attempt);
        }
    }
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", chunk => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error("请求体过大"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
            } catch {
                reject(new Error("JSON格式无效"));
            }
        });
        req.on("error", reject);
    });
}

async function startServer() {
    requireConfiguration();
    const store = createWatchlistStore();
    await store.initialize();
    await store.registerSubscriber({ chatId: ADMIN_CHAT_ID });
    await store.seed(ADMIN_CHAT_ID, DEFAULT_TARGETS);
    await store.migrateLegacyScheduledRuns(ADMIN_CHAT_ID);
    const marketService = createMarketService({ httpClient: createHttpClient(), requestWithRetry });
    const controller = createBotController({
        store,
        marketService,
        sendMessage: sendTelegramTo,
        answerCallback: answerCallbackQuery,
        inviteCode: process.env.BOT_INVITE_CODE || ""
    });

    const server = http.createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/healthz") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (req.method !== "POST" || req.url !== "/telegram/webhook") {
            res.writeHead(404);
            res.end("not found");
            return;
        }
        if (!secureEqual(req.headers["x-telegram-bot-api-secret-token"], WEBHOOK_SECRET)) {
            res.writeHead(401);
            res.end("unauthorized");
            return;
        }
        try {
            const update = await readJsonBody(req);
            res.writeHead(200);
            res.end("ok");
            setImmediate(() => controller.handleUpdate(update).catch(async error => {
                console.error(`❌ Telegram更新处理失败：${error.message}`);
                const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
                const subscriber = chatId ? await store.getSubscriber(chatId).catch(() => null) : null;
                if (subscriber?.status === "active") {
                    sendTelegramTo(chatId, "❌ 操作失败，请稍后重试。").catch(() => {});
                }
            }));
        } catch (error) {
            res.writeHead(400);
            res.end("bad request");
        }
    });

    server.listen(PORT, HOST, () => {
        console.log(`🤖 Telegram webhook服务已监听 ${HOST}:${PORT}`);
        const publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
        if (publicBaseUrl) {
            configureTelegramWebhook({ baseUrl: publicBaseUrl })
                .then(webhookUrl => console.log(`✅ Telegram webhook已自动配置为 ${webhookUrl}`))
                .catch(error => console.error(`❌ Telegram webhook自动配置失败：${error.message}`));
        }
    });

    async function shutdown(signal) {
        console.log(`收到${signal}，正在关闭服务...`);
        server.close(async () => {
            await store.close();
            process.exit(0);
        });
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    return { controller, server, store };
}

if (require.main === module) {
    startServer().catch(error => {
        console.error(`❌ Webhook服务启动失败：${error.message}`);
        process.exit(1);
    });
}

module.exports = { readJsonBody, secureEqual, startServer };
