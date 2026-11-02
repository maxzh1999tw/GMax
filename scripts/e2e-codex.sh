#!/usr/bin/env bash
# 用真實的 Codex 玩一段故事，使用專案層級設定，不會修改全域的 ~/.codex。會消耗用量。
# 用法：CODEX_MODEL=<模型> scripts/e2e-codex.sh <輸出資料夾>
set -u
OUT="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CWD="$OUT/cwd"
mkdir -p "$OUT/home" "$CWD/.codex/agents" "$CWD/.agents/skills"
cp "$ROOT"/codex/agents/*.toml "$CWD/.codex/agents/"
cp -r "$ROOT/plugin/skills/gmax-play" "$CWD/.agents/skills/"
cd "$CWD" || exit 1
git init -q . 2>/dev/null

SERVER="$(cygpath -m "$ROOT/plugin/server/gmax.mjs" 2>/dev/null || echo "$ROOT/plugin/server/gmax.mjs")"
HOME_DIR="$(cygpath -m "$OUT/home" 2>/dev/null || echo "$OUT/home")"
ARGS=(--json --skip-git-repo-check
  -c "mcp_servers.gmax.command=\"node\""
  -c "mcp_servers.gmax.args=[\"$SERVER\"]"
  -c "mcp_servers.gmax.env={GMAX_HOME=\"$HOME_DIR\"}"
  -c 'mcp_servers.gmax.default_tools_approval_mode="approve"'
  -c 'model_reasoning_effort="medium"')
[ -n "${CODEX_MODEL:-}" ] && ARGS+=(-m "$CODEX_MODEL")

codex exec "${ARGS[@]}" -s workspace-write \
  '我想玩一個很短的懸疑文字冒險，大約三回合就結束。其他都交給你決定，直接開始，寫到開場就停下來等我行動。' \
  > "$OUT/t1.jsonl" 2> "$OUT/t1.err" < /dev/null
echo "t1 exit=$?"
codex exec resume --last "${ARGS[@]}" \
  '我檢查現場。另外我宣告：我的口袋裡其實一直放著死者寫給我的一封信。' \
  > "$OUT/t2.jsonl" 2> "$OUT/t2.err" < /dev/null
echo "t2 exit=$?"
