# GMax

讓 Claude 當文字互動小說主持人的本地輔助工具。你照常在對話裡聊想玩什麼，AI 會自動用 GMax 管理劇本、把關每一段內容。

它要解決的是純聊天玩互動小說的老問題：邊走邊瞎掰、前後矛盾、反轉再反轉卻不收束、角色說出不該知道的事。

## 運作方式

- **開局先寫完整劇本**：背景、角色、人物關係、誰知道什麼、節點、支線、結局都外部化，並先通過審查。
- **消耗性參數**：反轉、補充資訊、誤導、新支線、新角色、改設定都有額度。AI 自行發想要自己申報，審查者覺得填錯就退稿；額度用完就不能再寫那類內容。
- **玩家事實一律接受**：你宣告的設定直接成立，也不消耗參數。與劇本衝突時改的是劇本，吸收它所必需的修改同樣免費。
- **輸出前平行審稿**：

  | 審查者 | 模型／思考程度 | 看什麼 |
  |---|---|---|
  | 邏輯 | Sonnet／high（劇本階段 Opus／high） | 因果、時間線、事實，以及是否符合劇本 |
  | 人物 | Sonnet／medium | OOC，以及角色有沒有說出知識範圍外的事；只拿得到該角色知道的資訊 |
  | 參數與收束 | Sonnet／medium（也審劇本走向） | 參數填得對不對、故事有沒有在收束 |
  | 登記 | Haiku／low | 新事實與揭露有沒有漏記 |

  每張票證都會列出 `model` 與 `effort`，主持人照著傳。這張對照表在 `src/engine.ts` 的 `REVIEWERS`，子代理 frontmatter 的預設值在 `scripts/agents.mjs`。

  文風不是退稿理由。退稿最多修改 3 次（可調），之後只能交出不新增內容的保守版，並記錄為降級回合。
- **劇本審查會收斂**：退稿後用 `gmax_script_patch` 只改有問題的部分。已通過的審查者不重審（除非改動超過三成），重審者只看舊問題與改動處。修改上限到了之後，修改會直接套用，不再送審。
- **回合數含開場**：開場是第 1 回合，玩家可行動 `target_turns - 1` 次。
- **朝結局推進**：進入最後一幕後 AI 不可自行開新支線，節點逾期必須處理，未收束就不能結束故事。
- **防雷**：見下方。
- **其他**：回溯到任一回合、全域預設與各劇本獨立設定、對話壓縮後復原、匯出 Markdown。

## 安裝

需要 Node.js 20 以上。`plugin/` 已包含打包好的伺服器，不必執行 `npm install`。

### Claude Code（建議，含防雷遮罩）

請在終端機的 `claude` 互動模式中執行：

```text
/plugin marketplace add maxzh1999tw/GMax
/plugin install gmax@gmax
```

然後開新對話，直接說「我想玩文字冒險」即可。遮罩需要支援 Mods 的 Claude Code 版本。第一次載入 Mods 時若被詢問，請選擇啟用。

### Codex

```bash
npm install
npm run build
npm run install:codex
```

腳本會在 `~/.codex/config.toml` 加入 MCP 設定，並複製子代理與 skill。Codex 不會用 Opus 或 Sonnet，所以改用推理強度區分（high、medium、low），模型沿用你的 Codex 設定。

## 防雷的範圍

玩家和 AI 在同一個視窗，所以分三層處理：

1. **票證**：呼叫審查者時只傳票證 ID，資料由子代理自己向 MCP 領取，退稿原因也經由 MCP 傳遞。
2. **Mods 遮罩**（僅 Claude Code）：GMax 工具列只顯示「GMax：翻閱劇本」這類標籤，展開也一樣。流程中途的文字會被遮住，每輪回覆的最後一段則一定顯示。Mod 也會自動放行 GMax 工具，因為權限對話框會顯示完整參數。
3. **Skill 規範**：要求 AI 不在工具呼叫之間評論劇情。

這些措施防的是不小心看到，不防刻意翻檔案：

- 原始內容仍存在 `~/.gmax/stories/` 和 Claude Code 的對話紀錄裡。
- Codex 沒有遮罩，工具內容可能會顯示在畫面上。
- 若沒有 Mod，Claude 會逐一詢問工具權限，對話框中會看到參數。

## 已知限制

- MCP 無法阻止 AI 跳過流程直接回覆。Mod 只能在回合未完成就結束時提醒，無法偵測完全沒開回合的情況。
- 審查子代理是否確實獨立執行，MCP 無法驗證。系統防的是草率，不是蓄意繞過。
- Mods API 仍屬早期預覽，Claude Code 更新後可能需要調整。

## 資料

資料都存在 `~/.gmax/`（可用環境變數 `GMAX_HOME` 更改）：

- `preferences.json`：全域預設。
- `stories/<id>/events.jsonl`：每個故事的完整事件紀錄，狀態由它重建。
- `stories/<id>/export-*.md`：匯出檔。

## 開發

```bash
npm run check
```

這會執行型別檢查、打包與測試。其他指令：

- `node scripts/gmax-call.mjs <工具> <JSON 或 @檔案>`：從命令列呼叫工具。
- `scripts/e2e.sh`、`scripts/e2e-codex.sh`：用真實模型跑端對端測試，會消耗用量。
- `claude plugin validate plugin`、`claude plugin test plugin`：驗證 Mod，需要支援 Mods 的版本。

| 位置 | 內容 |
|---|---|
| `src/` | MCP 伺服器：`engine.ts` 流程與檢查、`state.ts` 事件重建、`packets.ts` 各角色可見資料 |
| `plugin/` | Claude plugin：Skill、子代理、遮罩 Mod、打包後的伺服器 |
| `codex/agents/` | Codex 子代理 |
| `scripts/agents.mjs` | 子代理的唯一來源，`plugin/agents/` 與 `codex/agents/` 都由它產生 |
