# Codex 工作室

在 Mac 上透過瀏覽器使用本機 Codex CLI。首頁固定提供純聊天，可新增共用提示詞、圖示與工作資料夾的情境。每個情境可保留多段對話，並行工作，從其他裝置接續，以及查看 Codex 的檔案產出。

## 安裝與啟動

準備 macOS、Node.js 24 以上、Poppler（提供 `pdftotext`），並完成 Codex CLI 登入。專案以 Codex CLI 0.167.0 驗證。 [Codex CLI 官方安裝說明](https://learn.chatgpt.com/docs/codex/cli)

```sh
git clone https://github.com/gwolf0719/codex-workspace.git
cd codex-workspace
npm ci
codex login status
npm start
```

在瀏覽器開啟 `http://127.0.0.1:4317`。首次啟動會產生隨機登入密碼，終端機會顯示密碼檔的位置。對話索引、附件和密碼預設存放在 `~/Library/Application Support/Codex Workspace`。

閱讀舊版 Word 或 Excel 需要安裝 LibreOffice。掃描 PDF 的文字辨識需要 macOS Swift 工具鏈。

### 區網使用

讓同一區網的手機或電腦連到 Mac 時，可在啟動時指定 Mac 的區網 IP。區網模式使用 HTTP，請在受信任的網路使用。

```sh
CHAT_HOST="$(ipconfig getifaddr en0)" npm start
```

| 環境變數 | 用途 |
|---|---|
| `CHAT_HOST` | 監聽位址，預設 `127.0.0.1` |
| `CHAT_PORT` | HTTP 連接埠，預設 `4317` |
| `CHAT_DATA_DIR` | 自訂本機資料目錄 |
| `CHAT_PASSWORD` | 覆蓋資料目錄中的登入密碼 |
| `CHAT_CODEX_BIN` | 指定 Codex CLI 的路徑 |
| `CHAT_PDFTOTEXT` | 指定 Poppler `pdftotext` 的路徑 |
| `CHAT_OFFICE_BIN` | 指定 LibreOffice 執行檔的絕對路徑 |

## 使用方式

- 點首頁「純聊天」或任一情境後即可送出新對話。舊對話可從該情境的側欄開啟。
- 自訂情境提供內建圖示、圖片上傳與 Codex 內建生圖。指定 Mac 上的絕對路徑可接上既有專案。留空時會自動配置情境資料夾。
- 模型和思考強度預設讀取本機 Codex 設定。每段對話可個別選擇，執行中的補充指示會送進當前輪次，模型變更於下一輪生效。
- 手機鎖屏、瀏覽器關閉或 Wi-Fi 斷線期間，Server 繼續處理任務。重新開啟時會補回消息和待核准項目。重啟 Mac 或 Server 會中斷正在執行的輪次，可接續已保存的對話。
- 聊天可附加 PDF、Word（`.doc`、`.docx`）和 Excel（`.xls`、`.xlsx`），每檔上限 25 MB。Codex 可讀取 PDF 文字、Word 段落與表格、Excel 各工作表的儲存格與公式。純掃描 PDF 可用 Mac 的 Vision OCR 辨識中英文，需要可用的 Swift 工具鏈。
- 可直接要求 Codex 輸出 PDF、Word 或 Excel，檔案會在對話中附上開啟與下載入口。Excel 預覽可切換工作表。情境檔案列表彙整各對話的產出。
- PDF 與 Word 支援標題、段落與表格。Excel 支援多個工作表、數值與工作簿內部公式。舊版 `.doc`、`.xls` 可直接上傳，Mac 會在沙箱內暫時轉換並保留原始附件。輸出格式為 `.pdf`、`.docx`、`.xlsx`。

## 權限與衝突

- 使用 Codex 的具名權限設定檔和工作室工具處理檔案。受管理的指令在 macOS 沙箱內執行，網路關閉。寫入指令須列出確切的檔案路徑。需要另外寫入暫存目錄、未宣告檔案或存取網路的指令會受到沙箱限制。
- 工作資料夾外的檔案由介面顯示完整路徑、讀寫種類和原因，使用者的核准只適用於這個工具呼叫。
- 工作室將受管理的寫入路徑鎖定至目前輪次結束。另一段對話遇到同一路徑時可等待釋放後重讀，或帶著使用者指示改用其他做法。寫入時也會驗證原檔版本。
- 工作室是單人自架應用。登入後可執行指令及核准檔案存取，服務適合本機或受信任的區網。

## 驗證

```sh
npm test
npm audit --omit=dev
```

整合測試涵蓋登入、WebSocket 斷線重連、並行對話、執行中補充指示、核准、兩種衝突處置、檔案預覽與下載。macOS 上也會驗證指令沙箱。實機測試使用隔離的資料目錄與已登入的 Codex，檢查檔案存取、命令、共用提示詞與原生圖片生成。

## 授權

本專案採用 MIT 授權，詳見 [LICENSE](LICENSE)。
