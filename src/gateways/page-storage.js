const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");
const { config } = require("../config");
const { createHttpClient, requestWithRetry } = require("../lib/http");

// 每日总结网页的静态托管：
// - Google Cloud Storage（DAILY_PAGE_BUCKET）：在GCP虚拟机上用元数据服务取虚拟机服务账号的访问令牌
//   （虚拟机需有 devstorage.read_write 权限范围）；本地调试时可用 GCS_ACCESS_TOKEN（gcloud auth print-access-token）
// - 本地目录（DAILY_PAGE_DIR）：本地调试用，由任意静态服务对外提供（DAILY_PAGE_BASE_URL）
const METADATA_TOKEN_URL = "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token";
const UPLOAD_BASE = "https://storage.googleapis.com/upload/storage/v1/b";
const GCS_PUBLIC_BASE = "https://storage.googleapis.com";
// 令牌提前1分钟换新
const TOKEN_MARGIN_MS = 60 * 1000;

let client;
function getClient() {
    if (!client) client = createHttpClient({ timeout: 30000, label: "Cloud Storage" });
    return client;
}

const token = { value: "", expiresAt: 0 };

async function accessToken() {
    if (config.dailyPage.accessToken) return config.dailyPage.accessToken;
    if (token.value && Date.now() < token.expiresAt) return token.value;
    // 元数据服务只在虚拟机内可达，不走代理
    const response = await axios.get(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" }, timeout: 5000, proxy: false });
    token.value = response.data.access_token;
    token.expiresAt = Date.now() + response.data.expires_in * 1000 - TOKEN_MARGIN_MS;
    return token.value;
}

async function uploadToBucket(name, body, { contentType, cacheControl }) {
    const bearer = await accessToken();
    const url = `${UPLOAD_BASE}/${encodeURIComponent(config.dailyPage.bucket)}/o`;
    // 元数据（Cache-Control）与内容一起上传，用 multipart 一次请求完成
    const boundary = `stock-agent-${Date.now().toString(16)}`;
    const metadata = JSON.stringify({ name, contentType, cacheControl });
    const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
        body,
        Buffer.from(`\r\n--${boundary}--`)
    ]);
    await requestWithRetry(() => getClient().post(url, payload, {
        params: { uploadType: "multipart" },
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": `multipart/related; boundary=${boundary}` },
        maxBodyLength: Infinity
    }), 2, 500);
}

async function writeToDir(name, body) {
    const file = path.join(config.dailyPage.dir, ...name.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
}

// 写入（覆盖）一个对象；会更新的内容用 no-cache，确保打开时是最新的
async function putObject(name, body, { contentType, cacheControl = "no-cache" }) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    if (config.dailyPage.bucket) await uploadToBucket(name, data, { contentType, cacheControl });
    else if (config.dailyPage.dir) await writeToDir(name, data);
    else throw new Error("缺少DAILY_PAGE_BUCKET或DAILY_PAGE_DIR");
    return publicUrl(name);
}

// 对象的访问地址；页面内互相引用也用它（GCS 的地址带存储桶名，不能用根路径）
function publicUrl(name) {
    const base = config.dailyPage.bucket ? `${GCS_PUBLIC_BASE}/${config.dailyPage.bucket}` : config.dailyPage.baseUrl;
    return `${base}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

module.exports = { publicUrl, putObject };
