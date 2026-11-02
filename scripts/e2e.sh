#!/usr/bin/env bash
# 實機端對端測試：用真實的 Claude Code 玩一段故事。會消耗用量。
# 用法：scripts/e2e.sh <claude 執行檔> <輸出資料夾>
set -u
CLAUDE="$1"
OUT="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT/home" "$OUT/cwd"
export GMAX_HOME="$OUT/home"
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT
cd "$OUT/cwd" || exit 1

run() { # 檔名 提示詞 [額外參數...]
  local name="$1" prompt="$2"; shift 2
  "$CLAUDE" -p "$prompt" --plugin-dir "$ROOT/plugin" --output-format stream-json --verbose \
    "$@" > "$OUT/$name.jsonl" 2> "$OUT/$name.err"
  echo "$name exit=$?"
}

run t1 '我想玩一個很短的懸疑文字冒險，大約三回合就結束。其他都交給你決定，直接開始，寫到開場就停下來等我行動。'
SID="$(grep -o '"session_id":"[^"]*"' "$OUT/t1.jsonl" | head -1 | cut -d'"' -f4)"
echo "$SID" > "$OUT/sid"
run t2 '我檢查現場。另外我宣告：我的口袋裡其實一直放著死者寫給我的一封信。' --resume "$SID"
run t3 '先暫停一下，不是故事內的話：你覺得這個故事目前的節奏怎麼樣？順便告訴我目前的參數消耗。' --resume "$SID"
