# 世新大學模擬器

**線上版本：<https://shucampus-ulqxcgfw.manus.game>**（直接用瀏覽器開啟即可遊玩，手機也可以）

「世新大學・漫遊校園」：在瀏覽器裡以第一人稱漫遊世新大學的 3D 概念校園：從前校門穿過隧道，經言論廣場、舍我樓、學校廣場、大禮堂與操場，走到新聞傳播學院所在的傳播大廈 C 棟。支援電腦鍵盤滑鼠與手機觸控，提供俯瞰、自動導覽、地標跳轉、小地圖、編輯模式（拖曳／旋轉場景中的模型），以及幾段校園玩笑互動情節。

> **概念模型／非精密測繪或正式路線指引。** 建築位置、步道與坡度為依資料與照片判讀的近似值。互動情節（校門警衛、隧道投影、董事會專車、言論廣場演講、電梯等）為虛構玩笑，人物與台詞皆為杜撰，不代表世新大學或任何人的實際言行。

技術：Three.js + TypeScript + Vite，純前端靜態網站，沒有後端或資料庫。

## 在自己的電腦執行

需要 [Node.js](https://nodejs.org/) 22（或 20.19 以上）與 pnpm 10。

```bash
corepack enable          # 啟用 pnpm（Node.js 內建）
pnpm install             # 安裝套件
pnpm dev                 # 開發伺服器 http://localhost:3000
pnpm build               # 型別檢查＋正式建置，輸出到 dist/
pnpm preview             # 預覽建置結果 http://localhost:4173
```

> **為什麼直接雙擊 `index.html` 會是空白？** 根目錄的 `index.html` 是原始碼入口，要透過 `pnpm dev` 編譯後才會顯示。建置後的 `dist/index.html` 也一樣：瀏覽器不允許以檔案方式（`file://`）執行網頁模組程式，必須經由網頁伺服器開啟，例如 `pnpm preview`，或放到網站空間。

`dist/` 內全部使用相對路徑，可以直接放到任何靜態網站空間（包含 GitHub Pages 的 `/<repo>/` 子路徑）。

## GitHub 與 Manus 連動

這個 repo 是 Manus 專案「世新大學・漫遊校園」的程式碼庫：在 Manus 上做的修改會存到這裡的 `main`，網站由 Manus 發布到上方的線上網址。

> 社群分享預覽圖（og:image）的網址設定在 `scripts/manus-game-sharing/build.mjs` 的 `publicationOrigin`，目前指向原本的 manus.game 網址；若網站改放到其他網址，改這一行即可。

## 操作

| 功能 | 電腦 | 手機 |
| --- | --- | --- |
| 移動 | WASD／方向鍵，按住 Shift 快走 | 左半邊拖曳＝搖桿（推到底快走） |
| 環顧 | 點畫面鎖定滑鼠後移動，或按住滑鼠拖曳；Esc 釋放滑鼠 | 右半邊拖曳 |
| 模式 | 1 步行・2 俯瞰・3 自動導覽・R 回到前校門 | 功能列按鈕；建議橫向並開全螢幕 |
| 互動 | 警衛盤查按 1／2／3 回答、空白鍵跳過台詞；坡頂黑色轎車旁按左鍵拿錘子再敲；舍我樓電梯前按 F | 右側出現的圓形動作鈕 |
| 編輯 | 按「編輯」後拖曳任一模型，Q／E 旋轉；調整存在本機瀏覽器，可匯出座標 | 同左 |

## 專案結構

| 路徑 | 內容 |
| --- | --- |
| `src/main.ts` | 進入點：渲染器、主迴圈、模式切換、各模組串接 |
| `src/campus/data.ts` | 座標系（x 向東、z 向南，單位公尺）、建物、步道、地形高度、路線 |
| `src/campus/site.ts` | 由 `tools/build_site.py` 產生的場地資料（OpenStreetMap／國土測繪中心資料整理後的結果，勿手改） |
| `src/campus/world.ts` | 3D 世界建構：地形、校舍、鄰房、樹木、隧道、廣場與各項設施 |
| `src/campus/audPlaza.ts` | 大禮堂樓梯與平台、學校廣場、八風舞台、後校門與警衛室 |
| `src/campus/geometry.ts` | 可步行範圍與碰撞判定 |
| `src/campus/explorer.ts` | 第一人稱移動、環顧、樓梯高度、相機特效 |
| `src/campus/story.ts`、`storyProps.ts`、`people.ts`、`car.ts`、`sfx.ts` | 互動情節、人物與道具、可破壞的車、合成音效 |
| `src/campus/editor.ts`、`movables.ts`、`edits.ts` | 編輯模式：拖曳／旋轉模型、儲存（瀏覽器 localStorage）與匯入匯出 |
| `src/campus/textures.ts`、`appearance.ts` | 程式化立面與材質、各棟外觀設定 |
| `src/ui/` | 介面：開始畫面、功能列、地標索引、小地圖、說明與來源、手機版面、劇情對話 |
| `src/styles/main.css` | 全部樣式 |
| `public/` | 網站圖示與字型（Sora） |
| `assets/share/` | 分享預覽圖與圖示原檔 |
| `tests/` | 單元測試（`pnpm test`） |
| `scripts/` | 建置與瀏覽器自動化檢查（見下方） |
| `tools/` | 產生場地資料與診斷用的 Python 工具（原始 GIS 資料不在此 repo 內） |
| `research-notes*.md`、`ideas.md` | 資料來源、照片判讀與實作決策紀錄 |

## 測試

```bash
pnpm test                               # 單元測試
pnpm exec playwright install chromium   # 第一次跑瀏覽器檢查前需要
pnpm build && pnpm smoke                # 桌機／手機煙霧測試
pnpm story                              # 互動情節檢查
pnpm mobile                             # 手機版面檢查
node scripts/edit-check.mjs             # 編輯模式檢查
```

瀏覽器檢查使用軟體繪圖，每項可能需要數分鐘。

## 參考來源

- 建築輪廓與步道：© OpenStreetMap contributors（ODbL），並以內政部國土測繪中心正射影像核對。
- [世新大學官方校園導覽地圖](https://www.shu.edu.tw/SHU-Location.aspx)（建築編號與相對位置）、[傳播大廈 C 棟樓層資訊](https://www.shu.edu.tw/SHU-Building-C.aspx)；樓層數依世新官網。
- 外觀、配色與附屬構造依作者拍攝的校園空拍與地面影片判讀；照片與影片僅作造型參考，場景中沒有使用任何照片貼圖，所有建築、材質與招牌皆以程式繪製。

## 第三方授權

- [three.js](https://threejs.org/)：MIT License
- Sora 字型：SIL Open Font License 1.1（見 `public/fonts/Sora-OFL.txt`）
