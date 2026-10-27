require("dotenv").config();

const { menuReplyMarkup } = require("../bot-service");
const { sendTelegram } = require("../telegram");

sendTelegram("✅ 本机股票追踪服务已启动。", { replyMarkup: menuReplyMarkup() })
    .catch(error => {
        console.error(`❌ 菜单发送失败：${error.message}`);
        process.exit(1);
    });
