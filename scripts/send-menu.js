require("dotenv").config();

const { removeKeyboardMarkup } = require("../bot-service");
const { sendTelegram } = require("../telegram");

sendTelegram("✅ 本机股票追踪服务已启动，点击左下角 Menu 选择操作。", { replyMarkup: removeKeyboardMarkup() })
    .catch(error => {
        console.error(`❌ 菜单发送失败：${error.message}`);
        process.exit(1);
    });
