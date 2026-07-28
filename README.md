# 雙語翻譯 (Gemini) — Chrome 擴充功能

保留網頁原文，並在每個段落下方顯示 Gemini 翻譯（預設繁體中文）。風格類似「沉浸式翻譯」。

## 功能
- 點工具列按鈕或按 **Alt+T** 翻譯目前頁面；再按一次還原原文。
- 進畫面才翻（捲到哪翻到哪），省 token。
- 以段落為單位、批次呼叫 Gemini，譯文順序對齊。
- 已是中文的段落自動跳過；翻譯失敗不影響原文。

## 一、免費申請 Gemini API Key
1. 到 [Google AI Studio → API keys](https://aistudio.google.com/apikey)，用 Google 帳號登入。
2. 點 **Create API key**，複製金鑰。
3. 免費層級即可使用（有每分鐘/每日次數限制）。

## 二、取得程式碼
- **用 git**：`git clone https://github.com/yPin9/gemini-web-translator.git`
- **或**在 GitHub 頁面點 **Code → Download ZIP**，解壓縮。
- 之後要更新：在資料夾裡執行 `git pull`，再到 `chrome://extensions` 點該擴充功能的 🔄 重新載入。

## 三、安裝（載入未封裝擴充功能）
1. Chrome 網址列輸入 `chrome://extensions`。
2. 右上角開啟 **開發人員模式 (Developer mode)**。
3. 點 **載入未封裝項目 (Load unpacked)**，選擇你 clone / 解壓後的資料夾。
4. 安裝後，點該擴充功能的 **選項 / Options**（或工具列圖示 → 開啟選項設定）。
5. 貼上你自己的 API key → 按「儲存」→「測試連線」確認成功。

> 在**多台電腦**用：每台都 clone/下載 → 載入未封裝 → 各自填一次自己的 API key（key 存在該台瀏覽器，不會上傳、也不會跟著 repo 走）。

## 三、使用
- 打開任一網頁 → 點工具列圖示 → **翻譯此頁**，或直接按 **Alt+T**。
- 譯文會以藍色小字接在每段原文下方。
- 再按一次 Alt+T 或按「還原原文」即可清除譯文。

## 檔案說明
| 檔案 | 作用 |
|------|------|
| `manifest.json` | 擴充功能設定 (Manifest V3) |
| `background.js` | Service worker：呼叫 Gemini API、快捷鍵、badge |
| `content.js` / `content.css` | 掃描段落、插入譯文、還原 |
| `popup.html` / `popup.js` | 工具列小視窗 |
| `options.html` / `options.js` | 設定 API key、模型、目標語言 |

## 備註
- API key 只存在本機瀏覽器 `chrome.storage.local`，不會上傳到第三方。
- 預設模型為 `gemini-2.5-flash-lite`（最省最快）。
- 若翻譯出現 `HTTP 429`，代表達到免費速率上限（免費層每分鐘 15 次），稍等幾秒會自動重試。
