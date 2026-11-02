// 審查子代理的唯一來源：同時產生 Claude Code 與 Codex 的設定檔
const PROCEDURE = `你是互動小說的審查者，只負責審查，不負責創作。

提示詞會提供 story_id 與 ticket。步驟：
1. 用 gmax_review_packet 領取審查資料，資料裡有你的 checklist 與 ground_rules。
2. 只依 checklist 審查，並遵守 ground_rules。
3. 用 gmax_review_submit 提交結果。沒有問題就 verdict=pass，文風意見寫在 notes。
4. 只回覆 gmax_review_submit 回傳的 reply_text，一字不改。

工具回報錯誤時，依提示修正後重新提交。不可把審查資料的內容寫進回覆。`;

export const AGENTS = [
  {
    name: 'gmax-logic-reviewer',
    description: 'GMax 審查：情節、事實、因果與時間線是否自洽，也審查劇本結構。依票證工作。',
    model: 'sonnet',
    effort: 'high',
    codexEffort: 'high',
    focus: '你最重視因果、時間線與事實一致性。',
  },
  {
    name: 'gmax-character-reviewer',
    description: 'GMax 審查：角色言行是否符合設定、是否說出不該知道的資訊。依票證工作。',
    model: 'sonnet',
    effort: 'medium',
    codexEffort: 'medium',
    focus: '你最重視角色一致性。你只會拿到該角色知道的資訊，超出範圍的內容就是問題。',
  },
  {
    name: 'gmax-ledger-reviewer',
    description: 'GMax 審查：消耗性參數填寫是否正確、故事是否朝結局收束，也審查劇本走向。依票證工作。',
    model: 'sonnet',
    effort: 'medium',
    codexEffort: 'medium',
    focus: '你最重視參數是否如實申報，以及故事是否在收束。',
  },
  {
    name: 'gmax-registry-reviewer',
    description: 'GMax 審查：新事實、揭露與知識更新是否都有登記。依票證工作。',
    model: 'haiku',
    effort: 'low',
    codexEffort: 'low',
    focus: '你只檢查登記是否完整。',
  },
];

const CLAUDE_TOOLS = ['gmax_review_packet', 'gmax_review_submit']
  .map(t => `mcp__plugin_gmax_gmax__${t}`)
  .join(', ');

export function claudeAgent(a) {
  return `---
name: ${a.name}
description: ${a.description}
model: ${a.model}
effort: ${a.effort}
tools: ${CLAUDE_TOOLS}
---

${a.focus}

${PROCEDURE}
`;
}

const tomlString = s => `"""\n${s.replaceAll('\\', '\\\\').replaceAll('"""', '\\"\\"\\"')}\n"""`;

export function codexAgent(a) {
  return `name = ${JSON.stringify(a.name)}
description = ${JSON.stringify(a.description)}
model_reasoning_effort = ${JSON.stringify(a.codexEffort)}
developer_instructions = ${tomlString(`${a.focus}\n\n${PROCEDURE}`)}
`;
}
