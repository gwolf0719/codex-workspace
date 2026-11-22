# Codex 工作室

- 依全域指引使用繁體中文，開工先讀 docs/code_map.md。若本機有 HANDOFF.md，也請讀取。
- 開發環境使用 macOS、Node.js 24 以上及本機 Codex CLI。由 Node HTTP 與 WebSocket 處理瀏覽器，由 stdio JSON-RPC 連接 Codex App Server。
- 檔案與指令使用 server/workspace.js 的權限檢查與路徑協調。調整權限時，跑自動化測試並使用隔離資料目錄測試真實 CLI。
- 修改前端時用 Codex 內建瀏覽器驗證。執行 npm test 和 npm audit --omit=dev。
- 本機資料、登入密碼與測試產出放在 repo 外。區網試用服務以 Mac 區網 IP 綁定。
