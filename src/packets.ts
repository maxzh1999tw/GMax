import { budgetsOf, currentAct, isFinalAct, type Fact, type Role, type StoryState } from './state.js';

const RECENT_TURNS = 3;
const DUE_SOON_TURNS = 2;

const GROUND_RULES = [
  '玩家事實（source=player）一律成立，不可因它與劇本衝突而退稿；衝突時應該修改的是劇本。',
  '文風、用詞與美感偏好不可作為退稿理由，只能寫在 notes。',
  '只在確定有問題時退稿，每項問題都要引用 ID 或草稿原文，並提出具體修改建議。',
  '最終回覆只寫 gmax_review_submit 回傳的 reply_text，不可重述任何內容。',
];

const SUBMIT_FORMAT = {
  verdict: 'pass 或 reject；pass 時 issues 可省略',
  issue_fields: 'category、excerpt（草稿原文，選填）、citations、explanation、suggestion（後兩者必填）、budget_correction（選填）',
  category: 'logic 因果／fact 事實矛盾／script 偏離劇本／character 角色言行／knowledge 知識外洩／budget 參數申報／convergence 未收束／registration 漏登記。文風不在其中。',
  citations: '可引用事實、角色、節點、支線、幕、參數的 ID，或 new:<key>；要指向角色欄位可寫 su.never。全新發明的內容沒有 ID，改用 excerpt 引用草稿原文即可。',
  budget_correction: '{ budget, should_spend }，should_spend 是此參數在這份草稿中應消耗的次數，不是累計。',
};

const SCRIPT_GROUND_RULES = [
  '只因會讓故事矛盾、無法進行或結局無法抵達的問題退稿。假設性追問與可在回合中自然處理的細節寫在 notes。',
];

const SCRIPT_RECHECK = '這是重新審查。只判斷 previous_issues 是否已修好，以及 changed_ids 的修改有沒有造成新問題。未變動的部分即使可以更好也寫在 notes，除非它會讓故事無法進行。';

const ROLE_SCOPE: Partial<Record<Role, string>> = {
  logic: '只管因果、事實與劇本。角色語氣與性格交給人物審查者，參數次數交給參數審查者；看到相關問題寫在 notes，除非它同時造成邏輯矛盾。',
  character: '只管角色。劇情走向與參數不歸你管。',
  ledger: '只管參數與收束。角色語氣不歸你管。',
  registry: '只管登記。不判斷內容好壞，也不判斷參數。',
};

const CHECKLISTS: Record<Role, string[]> = {
  logic: [
    '因果與時間線是否成立，是否與有效事實矛盾。',
    '情節是否符合目前的幕與節點；偏離劇本時，是否由玩家事實造成。',
    '標記為 player_consequence 或帶 cause_fact 的修改，是否真的是吸收玩家事實所必需。夾帶 AI 自己的發想要退稿並要求申報參數（category: budget）。',
    '節點標記 hit、adapted 或 dropped 是否與內容相符。',
  ],
  character: [
    '言行是否符合 persona、voice、goals 與 never（OOC 檢查）。',
    '角色是否說出或依據 known_facts 以外的資訊行動。有合理推測依據的不算。',
    '角色的錯誤認知（beliefs）是否被遵守；角色可以說謊，但要符合其動機。',
    '只審查有出場的角色，不評論劇情走向。',
  ],
  ledger: [
    '逐條列出草稿的新斷言，判斷它是：既有資訊、無害細節、玩家事實的必要結果，或 AI 自行發想。',
    'AI 自行發想且會影響情節的內容，必須依參數定義申報。漏報、多報或分類錯誤都要退稿，並用 budget_correction 寫出該參數的正確次數。',
    '玩家事實與吸收它所必需的修改一律不扣參數。',
    '故事是否朝結局收束：後段不應繼續發散、堆疊反轉；逾期節點與未收束支線要被處理。',
  ],
  registry: [
    '草稿裡會影響後續的新設定，是否都登記在 new_facts。天氣、擺設、場景氣氛這類不影響後續的細節不用登記；拿不準就寫在 notes，不要退稿。',
    '揭露給玩家的既有事實是否列入 revealed_facts；角色新得知的資訊是否列入 knowledge_updates。',
    '開啟或收束的故事線是否登記。',
    '玩家事實與 player_known=true 的事實玩家本來就知道，不用列入 revealed_facts。',
    '只檢查登記是否完整，不判斷好壞。',
  ],
  script_logic: [
    '時間線、因果、動機與角色知識分配是否自洽。',
    '每個祕密是否有足夠且公平的線索，結局是否都能從劇本合理抵達。',
    '節點順序是否可行，揭露的事實是否與知情者安排相符。',
  ],
  script_drama: [
    '是否符合玩家需求與故事類型，走向是否有吸引力。',
    '每一幕是否有明確的推進與張力變化，支線是否都有收束點。',
    '反轉與誤導是否已寫入劇本，而不是留待即興發揮。',
    '角色是否鮮明且彼此有衝突；只判斷結構，不評論文風。',
  ],
};

function factView(f: Fact) {
  return {
    id: f.id, kind: f.kind, text: f.text, when: f.when, source: f.source,
    known_by: f.known_by, player_known: f.player_known, secret: f.secret || undefined,
    supports: f.supports.length ? f.supports : undefined,
    amended: f.history.length ? f.history : undefined,
  };
}

function recentTurns(s: StoryState) {
  return s.turns.slice(-RECENT_TURNS).map(t => ({ turn: t.number, player: t.player_input, text: t.text }));
}

function budgetsView(s: StoryState) {
  return Object.fromEntries(Object.entries(budgetsOf(s)).map(([k, b]) => [k, {
    label: b.label, definition: b.definition, spent: b.spent, limit: b.limit, remaining: b.remaining,
  }]));
}

function directives(s: StoryState): string[] {
  const out: string[] = [];
  const turn = s.current?.number ?? (s.turns.at(-1)?.number ?? 0) + 1;
  const act = currentAct(s);
  if (turn === 1) out.push('這是開場，玩家還沒行動。只鋪陳情境與可行動的線索，不可替玩家調查或做決定。');
  const beats = Object.values(s.beats).filter(b => b.must_hit && b.status === 'pending');
  for (const b of beats) {
    if (b.deadline_turn && b.deadline_turn < turn) out.push(`必經節點 ${b.id}（${b.title}）已逾期，本回合必須達成或調整。`);
    else if (b.deadline_turn && b.deadline_turn <= turn + DUE_SOON_TURNS) out.push(`必經節點 ${b.id}（${b.title}）將在第 ${b.deadline_turn} 回合到期，請開始推進。`);
  }
  if (act && turn > act.target_end_turn) out.push(`目前的幕「${act.title}」已超過目標回合（${act.target_end_turn}），請收束本幕。`);
  if (isFinalAct(s)) {
    const open = Object.values(s.threads).filter(t => t.status === 'open');
    out.push(`已進入最後一幕：AI 不可自行開新支線，請朝結局收束。尚有 ${open.length} 條支線未收束。`);
  }
  for (const t of Object.values(s.threads)) {
    if (t.status !== 'open' || !t.resolve_by_act || !s.script) continue;
    const acts = s.script.acts.map(a => a.id);
    if (act && acts.indexOf(t.resolve_by_act) <= acts.indexOf(act.id)) out.push(`支線 ${t.id}（${t.title}）應在本幕收束。`);
  }
  for (const [key, b] of Object.entries(budgetsOf(s))) {
    if (b.remaining === 0) out.push(`參數 ${b.label}（${key}）已用完，不可再寫這類內容。`);
  }
  return out;
}

/** 給寫手的資料。full 用於開局與對話被壓縮後復原，平常只給當前需要的部分以節省上下文。 */
export function writerBrief(s: StoryState, full: boolean) {
  const act = currentAct(s);
  const turn = s.current?.number ?? (s.turns.at(-1)?.number ?? 0) + 1;
  const recentFacts = Object.values(s.facts).filter(f => f.turn > 0 && f.turn >= turn - RECENT_TURNS).map(factView);
  const base = {
    turn,
    settings: {
      language: s.settings.language,
      style: s.script?.style_guide || s.settings.style,
      pov: s.settings.pov,
      length_per_turn: s.settings.length_per_turn,
      player_profile: s.settings.player_profile,
      content_boundaries: s.settings.content_boundaries,
    },
    player_input: s.current?.player_input,
    player_facts: (s.current?.player_fact_ids ?? []).map(id => factView(s.facts[id]!)),
    act,
    act_beats: Object.values(s.beats).filter(b => b.act === act?.id),
    directives: directives(s),
    budgets: budgetsView(s),
    open_threads: Object.values(s.threads).filter(t => t.status === 'open'),
    recent_facts: recentFacts,
  };
  if (!full) {
    return { ...base, reminder: '不確定設定時用 gmax_script_read 查詢；對話若被壓縮，用 gmax_story_resume 復原。' };
  }
  return { ...base, script: scriptPacket(s), recent_turns: recentTurns(s) };
}

export function scriptPacket(s: StoryState, section?: string) {
  const all = {
    premise: s.script?.premise,
    genre: s.script?.genre,
    style_guide: s.script?.style_guide,
    player: s.script?.player,
    characters: Object.values(s.characters),
    relationships: s.script?.relationships,
    facts: Object.values(s.facts).map(factView),
    acts: s.script?.acts,
    beats: Object.values(s.beats),
    threads: Object.values(s.threads),
    endings: s.script?.endings,
  };
  if (section && section in all) return { [section]: all[section as keyof typeof all] };
  return all;
}

function characterKnowledge(s: StoryState, id: string) {
  return Object.values(s.facts)
    .filter(f => f.known_by.includes(id) || f.known_by.includes('*'))
    .map(f => ({ id: f.id, text: f.text }));
}

/** 依角色只提供必要資料，尤其人物審查者看不到角色知識範圍外的事實。 */
export function reviewPacket(s: StoryState, role: Role) {
  const base = { role, scope: ROLE_SCOPE[role], checklist: CHECKLISTS[role], ground_rules: GROUND_RULES, submit_format: SUBMIT_FORMAT };

  if (role === 'script_logic' || role === 'script_drama') {
    const recheck = s.script_round > 1;
    return {
      ...base,
      ground_rules: [...GROUND_RULES, ...SCRIPT_GROUND_RULES, ...(recheck ? [SCRIPT_RECHECK] : [])],
      round: s.script_round,
      previous_issues: recheck ? s.script_prior_issues[role] : undefined,
      changed_ids: recheck ? s.script_changed : undefined,
      settings: s.settings,
      script: scriptPacket(s),
    };
  }

  const cur = s.current!;
  const d = cur.declaration!;
  const draft = {
    turn: cur.number,
    round: cur.round,
    previous_issues: cur.prior_issues[role],
    player_input: cur.player_input,
    player_facts: cur.player_fact_ids.map(id => factView(s.facts[id]!)),
    text: cur.text,
  };

  if (role === 'character') {
    const present = d.characters_present.map(id => {
      const card = s.characters[id] ?? d.new_characters.find(c => c.id === id);
      return {
        card,
        known_facts: characterKnowledge(s, id),
        relationships: s.script?.relationships.filter(r => r.from === id || r.to === id),
      };
    });
    return { ...base, draft, characters: present, knowledge_updates: d.knowledge_updates, new_facts: d.new_facts.map(f => ({ key: f.key, text: f.text, known_by: f.known_by })) };
  }

  if (role === 'logic') {
    return { ...base, draft, declaration: d, recent_turns: recentTurns(s), current_act: currentAct(s), script: scriptPacket(s) };
  }

  if (role === 'ledger') {
    return {
      ...base, draft, declaration: d,
      budgets: budgetsView(s),
      known_registry: Object.values(s.facts).map(f => ({ id: f.id, text: f.text, source: f.source, player_known: f.player_known })),
      characters: Object.values(s.characters).map(c => ({ id: c.id, name: c.name, role: c.role, persona: c.persona })),
      beats: Object.values(s.beats).map(b => ({ id: b.id, act: b.act, title: b.title, description: b.description, status: b.status, must_hit: b.must_hit, deadline_turn: b.deadline_turn })),
      threads: Object.values(s.threads),
      current_act: currentAct(s),
      is_final_act: isFinalAct(s),
      directives: directives(s),
    };
  }

  return {
    ...base, draft, declaration: d,
    known_registry: Object.values(s.facts).map(f => ({ id: f.id, text: f.text, player_known: f.player_known, known_by: f.known_by })),
    threads: Object.values(s.threads).map(t => ({ id: t.id, title: t.title, status: t.status })),
  };
}

export function exportMarkdown(s: StoryState, includeScript: boolean): string {
  const lines = [`# ${s.title}`, ''];
  for (const t of s.turns) {
    lines.push(`## 第 ${t.number} 回合`, '', `> ${t.player_input.replace(/\n/g, '\n> ')}`, '', t.text, '');
  }
  if (includeScript && s.script) {
    lines.push('---', '', '# 幕後劇本', '', '```json', JSON.stringify(scriptPacket(s), null, 2), '```', '');
    lines.push('## 參數消耗', '');
    for (const t of s.turns) {
      for (const spend of t.spends) lines.push(`- 第 ${t.number} 回合 ${spend.budget}：${spend.reason}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
