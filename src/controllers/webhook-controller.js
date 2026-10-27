const crypto = require("node:crypto");
const { WEBHOOK_PATH } = require("../constants");

const MAX_BODY_BYTES = 1024 * 1024;

// 常量时间比较，避免通过响应耗时猜测webhook密钥
function secureEqual(actual, expected) {
    const a = Buffer.from(String(actual || ""));
    const b = Buffer.from(String(expected || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
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

function respond(res, status, body, headers = {}) {
    res.writeHead(status, headers);
    res.end(body);
}

// HTTP路由：GET /healthz 健康检查；POST /telegram/webhook 校验密钥后立即应答，再异步处理更新
function createWebhookHandler({ botController, webhookSecret }) {
    return async function handleRequest(req, res) {
        if (req.method === "GET" && req.url === "/healthz") {
            return respond(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json" });
        }
        if (req.method !== "POST" || req.url !== WEBHOOK_PATH) return respond(res, 404, "not found");
        if (!secureEqual(req.headers["x-telegram-bot-api-secret-token"], webhookSecret)) {
            return respond(res, 401, "unauthorized");
        }
        let update;
        try {
            update = await readJsonBody(req);
        } catch {
            return respond(res, 400, "bad request");
        }
        // 先返回200，避免Telegram因处理耗时而重复投递同一更新
        respond(res, 200, "ok");
        setImmediate(() => botController.handleUpdateSafely(update));
    };
}

module.exports = { createWebhookHandler, readJsonBody, secureEqual };
