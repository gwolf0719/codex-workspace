# 程式索引

| 功能 | 入口 | 主要責任 | 驗證 |
|---|---|---|---|
| 登入、情境、檔案、WebSocket | server/index.js | 密碼與 Cookie、情境設定、附件和產出下載 | npm test |
| Codex App Server | server/codex.js | stdio 連線及 JSON-RPC | 真實 CLI 串流回覆 |
| 對話與核准 | server/sessions.js | 對話生命週期、模型、共用提示詞、核准與生圖 | npm test、兩個獨立登入 |
| 檔案與指令 | server/workspace.js | 路徑檢查、版本、同檔編輯、透過 macOS 沙箱執行命令 | npm test |
| PDF、Word、Excel | server/documents.js、server/pdf-ocr.swift、server/legacy-office.js | 文件擷取、掃描 OCR、舊版 Office 轉換、檔案生成 | npm test、附件上傳與真實 Codex 讀取 |
| 狀態與產出索引 | server/store.js | SQLite 儲存 | npm test |
| 灰階瀏覽器介面 | public/app.js、public/style.css | 情境首頁、聊天、核准、對話紀錄與檔案 | 內建瀏覽器與 RWD |
