import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  declarationSchema, preferencesPatchSchema, preferencesSchema, reviewIssueSchema, scriptPatchSchema, scriptSchema,
  type Declaration, type Preferences, type ReviewIssue, type Script, type ScriptPatch,
} from './schema.js';
import { GmaxError, type Store } from './store.js';
import {
  budgetsOf, currentAct, isFinalAct, statusLine, storyReadyToEnd,
  type ReviewResult, type Role, type StoryEvent, type StoryState, type Ticket,
} from './state.js';
import { exportMarkdown, reviewPacket, scriptPacket, writerBrief } from './packets.js';

/** 改動超過此比例的段落時，已通過的審查者全部重審。 */
const MAJOR_CHANGE_RATIO = 0.3;

/** 劇本一旦有錯，後面每回合都受影響，所以高階模型只用在劇本邏輯。 */
export const REVIEWERS: Record<Role, { agent: string; model: string; effort: string }> = {
  script_logic: { agent: 'gmax-logic-reviewer', model: 'opus', effort: 'high' },
  logic: { agent: 'gmax-logic-reviewer', model: 'sonnet', effort: 'high' },
  script_drama: { agent: 'gmax-ledger-reviewer', model: 'sonnet', effort: 'medium' },
  ledger: { agent: 'gmax-ledger-reviewer', model: 'sonnet', effort: 'medium' },
  character: { agent: 'gmax-character-reviewer', model: 'sonnet', effort: 'medium' },
  registry: { agent: 'gmax-registry-reviewer', model: 'haiku', effort: 'low' },
};

const newTicket = (role: Role, round: number): Ticket => ({
  ticket: `T-${randomBytes(9).toString('hex')}`,
  role,
  round,
});

const describeTickets = (tickets: Ticket[]) =>
  tickets.map(t => ({ ticket: t.ticket, role: t.role, ...REVIEWERS[t.role] }));

const normalize = (text: string) => text.replace(/\s+/g, '');

const includesExcerpt = (text: string, excerpt: string) =>
  normalize(text).includes(normalize(excerpt));

function paragraphs(text: string): string[] {
  return text.split(/\n+/).map(p => p.trim()).filter(Boolean);
}

export function changeRatio(before: string, after: string): number {
  const old = new Set(paragraphs(before));
  const next = paragraphs(after);
  const total = next.reduce((n, p) => n + p.length, 0);
  if (total === 0) return 1;
  return next.filter(p => !old.has(p)).reduce((n, p) => n + p.length, 0) / total;
}

const SCRIPT_SECTIONS = ['characters', 'facts', 'acts', 'beats', 'threads', 'endings'] as const;
const SCRIPT_FIELDS = ['premise', 'genre', 'style_guide', 'player', 'relationships'] as const;

export function mergeScript(script: Script, patch: ScriptPatch): Script {
  const merged: Record<string, unknown> = { ...script, ...patch.set };
  for (const section of SCRIPT_SECTIONS) {
    const removed = new Set<string>(patch.remove?.[section] ?? []);
    const items = (script[section] as { id: string }[]).filter(x => !removed.has(x.id));
    for (const item of (patch.upsert?.[section] ?? []) as { id: string }[]) {
      const at = items.findIndex(x => x.id === item.id);
      if (at >= 0) items[at] = item;
      else items.push(item);
    }
    merged[section] = items;
  }
  return scriptSchema.parse(merged);
}

/** 回傳有變動的欄位與項目 ID，以及它們占整份劇本的比例。 */
export function scriptChanges(before: Script, after: Script): { changed: string[]; ratio: number } {
  const changed: string[] = SCRIPT_FIELDS.filter(f => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
  let total = SCRIPT_FIELDS.length;
  for (const section of SCRIPT_SECTIONS) {
    const old = new Map((before[section] as { id: string }[]).map(x => [x.id, JSON.stringify(x)]));
    const next = after[section] as { id: string }[];
    const ids = new Set([...old.keys(), ...next.map(x => x.id)]);
    total += ids.size;
    for (const id of ids) {
      const item = next.find(x => x.id === id);
      if (!item || old.get(id) !== JSON.stringify(item)) changed.push(id);
    }
  }
  return { changed, ratio: changed.length / total };
}

/** 依 length_per_turn 檢查字數，只提醒、不擋稿。 */
function lengthReport(text: string, target: string) {
  const chars = normalize(text).length;
  const range = /(\d+)\s*[～~\-–]\s*(\d+)/.exec(target);
  const warning = range && chars > Number(range[2])
    ? `本段 ${chars} 字，超過目標 ${target}。不影響送審，之後盡量精簡。`
    : undefined;
  return { chars, target, warning };
}

/** 檢查劇本結構。errors 會阻止送審，warnings 交由審查者判斷。 */
export function validateScript(script: Script, settings: Preferences) {
  const errors: string[] = [];
  const warnings: string[] = [];

  const unique = (label: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`${label} ID 重複：${id}`);
      seen.add(id);
    }
    return seen;
  };
  const chars = unique('角色', script.characters.map(c => c.id));
  const facts = unique('事實', script.facts.map(f => f.id));
  const acts = unique('幕', script.acts.map(a => a.id));
  unique('節點', script.beats.map(b => b.id));
  unique('支線', script.threads.map(t => t.id));
  unique('結局', script.endings.map(e => e.id));

  for (const r of script.relationships) {
    for (const id of [r.from, r.to]) {
      if (id !== 'player' && !chars.has(id)) errors.push(`人物關係引用不存在的角色：${id}`);
    }
  }
  for (const f of script.facts) {
    for (const who of f.known_by) {
      if (who !== '*' && who !== 'player' && !chars.has(who)) errors.push(`事實 ${f.id} 的知情者不存在：${who}`);
    }
    for (const s of f.supports) {
      if (!facts.has(s)) errors.push(`線索 ${f.id} 指向不存在的事實：${s}`);
    }
  }
  for (const c of script.characters) {
    for (const belief of c.beliefs) {
      if (belief.about && !facts.has(belief.about)) errors.push(`角色 ${c.id} 的認知指向不存在的事實：${belief.about}`);
    }
  }
  for (const b of script.beats) {
    if (!acts.has(b.act)) errors.push(`節點 ${b.id} 屬於不存在的幕：${b.act}`);
    for (const f of b.reveals) {
      if (!facts.has(f)) errors.push(`節點 ${b.id} 揭露不存在的事實：${f}`);
    }
  }
  for (const t of script.threads) {
    if (t.resolve_by_act && !acts.has(t.resolve_by_act)) errors.push(`支線 ${t.id} 的收束幕不存在：${t.resolve_by_act}`);
  }
  for (const a of script.acts) {
    if (!script.beats.some(b => b.act === a.id && b.must_hit)) errors.push(`幕 ${a.id} 沒有必經節點，無法判斷何時推進`);
  }
  for (let i = 1; i < script.acts.length; i++) {
    if (script.acts[i]!.target_end_turn <= script.acts[i - 1]!.target_end_turn) {
      errors.push(`幕 ${script.acts[i]!.id} 的 target_end_turn 必須大於前一幕`);
    }
  }

  for (const secret of script.facts.filter(f => f.secret)) {
    const clues = script.facts.filter(f => f.kind === 'clue' && f.supports.includes(secret.id));
    if (clues.length < settings.min_clues_per_secret) {
      errors.push(`祕密 ${secret.id} 只有 ${clues.length} 條線索，至少需要 ${settings.min_clues_per_secret} 條`);
    }
  }
  const revealed = new Set(script.beats.flatMap(b => b.reveals));
  for (const f of script.facts) {
    if (f.secret && !revealed.has(f.id)) warnings.push(`祕密 ${f.id} 沒有任何節點負責揭露`);
  }
  const last = script.acts.at(-1);
  if (last && last.target_end_turn > settings.target_turns * 1.5) {
    warnings.push(`最後一幕的回合目標（${last.target_end_turn}）遠大於設定的總回合數（${settings.target_turns}）`);
  }
  for (const b of script.beats) {
    if (b.must_hit && b.deadline_turn === 1) {
      warnings.push(`節點 ${b.id} 的參考回合是第 1 回合，但第 1 回合是開場，玩家還沒行動。需要玩家行動的節點請排在第 2 回合以後。`);
    }
  }
  return { errors, warnings };
}

export function checkDraft(s: StoryState, text: string, d: Declaration, conservative: boolean): string[] {
  const problems: string[] = [];
  const budgets = budgetsOf(s);
  const isPlayerFact = (id?: string) => !!id && s.facts[id]?.source === 'player';
  const spendCount = (budget: string) => d.spends.filter(x => x.budget === budget).length;

  if (!text.trim()) problems.push('草稿是空的。');

  if (conservative) {
    if (d.spends.length || d.new_facts.some(f => f.basis !== 'detail') || d.new_characters.length || d.threads_opened.length || d.script_amendments.length) {
      problems.push('保守版只能使用無害細節，不可消耗參數、新增角色、開新支線或修改劇本。');
    }
  }

  for (const id of d.characters_present) {
    if (!s.characters[id] && !d.new_characters.some(c => c.id === id)) problems.push(`出場角色不存在：${id}`);
  }
  for (const spend of d.spends) {
    if (!budgets[spend.budget]) problems.push(`參數不存在：${spend.budget}`);
    if (!includesExcerpt(text, spend.excerpt)) problems.push(`參數 ${spend.budget} 引用的片段不在草稿中：「${spend.excerpt}」`);
  }
  for (const [key, b] of Object.entries(budgets)) {
    const n = spendCount(key);
    if (n > b.remaining) problems.push(`${b.label} 額度不足：本回合申報 ${n} 次，只剩 ${b.remaining} 次。請改寫，不可超支。`);
  }

  const keys = new Set<string>();
  for (const f of d.new_facts) {
    if (keys.has(f.key)) problems.push(`新事實 key 重複：${f.key}`);
    keys.add(f.key);
    if (f.basis === 'player_consequence' && !isPlayerFact(f.cause_fact)) {
      problems.push(`新事實 ${f.key} 標記為玩家事實的結果，但 cause_fact 不是玩家事實。`);
    }
    if (f.basis === 'spend' && (!f.budget || spendCount(f.budget) === 0)) {
      problems.push(`新事實 ${f.key} 標記為消耗參數，但沒有對應的 spends 項目。`);
    }
    for (const who of f.known_by) {
      if (who !== '*' && who !== 'player' && !s.characters[who] && !d.new_characters.some(c => c.id === who)) {
        problems.push(`新事實 ${f.key} 的知情者不存在：${who}`);
      }
    }
  }
  for (const id of d.revealed_facts) {
    if (!s.facts[id]) problems.push(`揭露的事實不存在：${id}`);
  }
  for (const k of d.knowledge_updates) {
    if (k.character !== 'player' && !s.characters[k.character] && !d.new_characters.some(c => c.id === k.character)) problems.push(`知識更新的角色不存在：${k.character}`);
    const ok = k.fact.startsWith('new:') ? keys.has(k.fact.slice(4)) : !!s.facts[k.fact];
    if (!ok) problems.push(`知識更新的事實不存在：${k.fact}`);
  }

  const paidCharacters = d.new_characters.filter(c => !isPlayerFact(c.cause_fact)).length;
  if (paidCharacters > spendCount('new_character')) problems.push('AI 自行新增角色必須申報 new_character。');
  for (const c of d.new_characters) {
    if (s.characters[c.id]) problems.push(`新角色 ID 已存在：${c.id}`);
  }

  const paidThreads = d.threads_opened.filter(t => !isPlayerFact(t.cause_fact));
  if (paidThreads.length > spendCount('new_thread')) problems.push('AI 自行開啟支線必須申報 new_thread。');
  if (isFinalAct(s) && paidThreads.length > 0) problems.push('故事已進入最後一幕，AI 不可再自行開啟新支線。');
  for (const t of d.threads_opened) {
    if (s.threads[t.key]) problems.push(`支線 ID 已存在：${t.key}`);
  }
  for (const t of d.threads_resolved) {
    if (s.threads[t.thread]?.status !== 'open') problems.push(`支線不存在或已結束：${t.thread}`);
  }

  let paidChanges = d.script_amendments.filter(a => !isPlayerFact(a.cause_fact)).length;
  for (const a of d.script_amendments) {
    if (!s.facts[a.target] && !s.beats[a.target] && !s.threads[a.target] && !s.characters[a.target]) {
      problems.push(`修改目標不存在：${a.target}`);
    }
    if (a.cause_fact && !isPlayerFact(a.cause_fact)) problems.push(`修改 ${a.target} 的 cause_fact 不是玩家事實。`);
  }

  for (const b of d.beat_updates) {
    const beat = s.beats[b.beat];
    if (!beat) problems.push(`節點不存在：${b.beat}`);
    else if (beat.status !== 'pending') problems.push(`節點已處理過：${b.beat}`);
    if (b.status === 'dropped' && beat?.must_hit && !isPlayerFact(b.cause_fact)) paidChanges += 1;
  }
  if (paidChanges > spendCount('retcon')) {
    problems.push('非玩家事實造成的修改或放棄必經節點，都必須申報 retcon。');
  }

  return problems;
}

/** 節點與支線的 note 只是說明，改動不需要重新審查。 */
const comparableDeclaration = (d?: Declaration) =>
  JSON.stringify(d, (key, value) => (key === 'note' ? undefined : value));

const WAIT_RULE = '子代理各自回報時不要查詢狀態；必須回應時只寫「主持人構思中…」，不要提進度。';

function requireStatus(s: StoryState, status: StoryState['status'], hint: string): void {
  if (s.status !== status) throw new GmaxError(`目前故事狀態是 ${s.status}，此操作需要 ${status}。`, hint);
}

function requireCurrent(s: StoryState) {
  if (!s.current) throw new GmaxError('目前沒有進行中的回合。', '請先呼叫 gmax_turn_begin。');
  return s.current;
}

function validateReview(role: Role, issues: ReviewIssue[], verdict: string, s: StoryState, text?: string): void {
  if (verdict === 'reject' && issues.length === 0) {
    throw new GmaxError('退稿必須至少附一項問題。', '文風偏好請寫在 notes，不可作為退稿理由。');
  }
  const decl = s.current?.declaration;
  const known = (raw: string) => {
    const id = raw.startsWith('new:') ? raw : raw.split('.')[0]!;
    return !!(s.facts[id] || s.characters[id] || s.beats[id] || s.threads[id])
      || s.script?.acts.some(a => a.id === id)
      || s.settings.budgets[id] !== undefined
      || (id.startsWith('new:') && decl?.new_facts.some(f => f.key === id.slice(4)))
      || decl?.new_characters.some(c => c.id === id);
  };
  for (const issue of issues) {
    for (const c of issue.citations) {
      if (!known(c)) throw new GmaxError(`引用的 ID 不存在：${c}`, '請只引用審查資料中出現的 ID。');
    }
    const grounded = issue.citations.length > 0 || (text !== undefined && issue.excerpt && includesExcerpt(text, issue.excerpt));
    if (!grounded) {
      throw new GmaxError('每項問題都必須引用 ID，或引用草稿中確實存在的原文。', `角色 ${role} 的問題「${issue.explanation.slice(0, 30)}」沒有依據。`);
    }
    if (text !== undefined && issue.excerpt && !includesExcerpt(text, issue.excerpt)) {
      throw new GmaxError(`引用的片段不在草稿中：「${issue.excerpt}」`);
    }
  }
}

const reviewInput = z.object({
  ticket: z.string(),
  verdict: z.enum(['pass', 'reject']),
  issues: z.array(reviewIssueSchema).default([]),
  notes: z.string().default(''),
});

export class Engine {
  constructor(readonly store: Store) {}

  preferencesGet() {
    return { ok: true, preferences: this.store.preferences(), next_action: '可用 gmax_preferences_update 修改，之後開的新故事才會套用。' };
  }

  preferencesUpdate(patch: unknown) {
    return { ok: true, preferences: this.store.updatePreferences(patch), next_action: '已更新。進行中的故事不受影響。' };
  }

  storyCreate(title: string, overrides: unknown = {}) {
    const patch = preferencesPatchSchema.parse(overrides);
    const settings = preferencesSchema.parse({ ...this.store.preferences(), ...patch });
    const id = `s-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    this.store.create(id, { type: 'story_created', id, title, settings, at: new Date().toISOString() });
    return {
      ok: true, story_id: id, phase: 'authoring', settings,
      turn_rule: `回合數只是節奏參考，不是限制。開場算第 1 回合，所以 target_turns=${settings.target_turns} 約等於玩家行動 ${settings.target_turns - 1} 次。`,
      next_action: '依玩家需求生成完整劇本後呼叫 gmax_script_submit。節點與幕的參考回合都要把開場算進去。劇本內容不可出現在給玩家的文字裡。',
    };
  }

  storyList() {
    const stories = this.store.listIds().map(id => {
      const s = this.store.state(id);
      return { story_id: id, title: s.title, status: s.status, turn: s.turns.at(-1)?.number ?? 0, created_at: s.created_at };
    }).sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { ok: true, stories, next_action: '用 gmax_story_resume 繼續某個故事。' };
  }

  settingsUpdate(storyId: string, patch: unknown) {
    const parsed = preferencesPatchSchema.parse(patch);
    return this.store.mutate(storyId, s => {
      const settings = preferencesSchema.parse({ ...s.settings, ...parsed });
      for (const [key, spent] of Object.entries(s.spent)) {
        if (!settings.budgets[key] && spent > 0) throw new GmaxError(`參數 ${key} 已有消耗，不可刪除。`);
      }
      return {
        events: [{ type: 'settings_updated', settings }],
        result: st => ({ ok: true, settings: st.settings, status_line: statusLine(st), next_action: '已更新此故事的設定，不影響全域預設。' }),
      };
    });
  }

  scriptSubmit(storyId: string, input: unknown) {
    const script = scriptSchema.parse(input);
    return this.store.mutate<object>(storyId, s => {
      requireStatus(s, 'authoring', '故事已開始後，請透過回合宣告的 script_amendments 修改。');
      return this.applyScript(s, script);
    });
  }

  scriptPatch(storyId: string, input: unknown) {
    const patch = scriptPatchSchema.parse(input);
    return this.store.mutate<object>(storyId, s => {
      requireStatus(s, 'authoring', '故事已開始後，請透過回合宣告的 script_amendments 修改。');
      if (!s.script) throw new GmaxError('尚未提交劇本。', '請先呼叫 gmax_script_submit。');
      return this.applyScript(s, mergeScript(s.script, patch));
    });
  }

  private applyScript(s: StoryState, script: Script): { events: StoryEvent[]; result: (s: StoryState) => object } {
    const { errors, warnings } = validateScript(script, s.settings);
    if (errors.length > 0) {
      return {
        events: [],
        result: () => ({ ok: false, phase: 'authoring', errors, warnings, next_action: '修正後重新呼叫 gmax_script_patch 或 gmax_script_submit。' }),
      };
    }
    if (s.script_round > s.settings.max_revisions) {
      if (s.script_tickets.some(t => !s.script_results[t.role])) {
        return {
          events: [],
          result: () => ({ ok: false, phase: 'authoring', errors: ['最後一輪審查尚未完成。'], warnings, next_action: '等審查完成後再修改。' }),
        };
      }
      return {
        events: [{ type: 'script_final_fix', script }],
        result: st => ({
          ok: true, phase: 'authoring', warnings, round: st.script_round, reviewers: [],
          next_action: '已套用修正。修改上限已到，這次不再送審。呼叫 gmax_story_start（帶 accept_issues:true）開始故事。',
        }),
      };
    }

    const round = s.script_round + 1;
    const roles: Role[] = ['script_logic', 'script_drama'];
    const { changed, ratio } = s.script ? scriptChanges(s.script, script) : { changed: [], ratio: 1 };
    const need = ratio > MAJOR_CHANGE_RATIO
      ? roles
      : roles.filter(r => s.script_results[r]?.verdict !== 'pass');
    const tickets = need.map(role => newTicket(role, round));
    const retained = roles.filter(r => !need.includes(r));
    return {
      events: [{ type: 'script_submitted', script, tickets, retained, changed }],
      result: () => ({
        ok: true, phase: 'authoring', warnings, round,
        reviewers: describeTickets(tickets),
        retained_passes: retained,
        next_action: tickets.length > 0
          ? `在同一則訊息平行啟動 reviewers 列出的子代理，每個都要帶上 model 與 effort，提示詞只傳票證，不可包含劇本內容。${WAIT_RULE}回報全部完成後呼叫 gmax_script_review_status。`
          : '不需要審查，呼叫 gmax_story_start。',
      }),
    };
  }

  scriptReviewStatus(storyId: string) {
    const s = this.store.state(storyId);
    const pending = s.script_tickets.filter(t => !s.script_results[t.role]);
    const rejected = s.script_tickets.filter(t => s.script_results[t.role]?.verdict === 'reject');
    const exhausted = s.script_round > s.settings.max_revisions;
    let next_action = '呼叫 gmax_story_start 開始故事。';
    if (pending.length > 0) next_action = '等待或重新啟動尚未回報的審查子代理。';
    else if (rejected.length > 0) {
      next_action = exhausted
        ? '修改上限已到，不會再送審。可用 gmax_script_patch 修掉這些問題（修改會直接套用），然後呼叫 gmax_story_start（帶 accept_issues:true）。'
        : '依問題呼叫 gmax_script_patch，只改有問題的部分。';
    }
    return {
      ok: true, phase: 'authoring', round: s.script_round,
      pending: describeTickets(pending),
      issues: Object.fromEntries(rejected.map(t => [t.role, s.script_results[t.role]!.issues])),
      next_action,
    };
  }

  storyStart(storyId: string, acceptIssues = false) {
    return this.store.mutate(storyId, s => {
      requireStatus(s, 'authoring', '故事已開始。');
      if (!s.script) throw new GmaxError('尚未提交劇本。', '請先呼叫 gmax_script_submit。');
      const pending = s.script_tickets.filter(t => !s.script_results[t.role]);
      const rejected = s.script_tickets.filter(t => s.script_results[t.role]?.verdict === 'reject');
      if (pending.length > 0) throw new GmaxError('劇本審查尚未完成。', '請先完成所有審查票證。');
      if (rejected.length > 0 && !(acceptIssues && s.script_round > s.settings.max_revisions)) {
        throw new GmaxError('劇本審查未通過。', s.script_round > s.settings.max_revisions
          ? '修改上限已到，請帶 accept_issues:true 開始。'
          : '請依 gmax_script_review_status 的問題用 gmax_script_patch 修改。accept_issues 只有在修改上限到了才有效。');
      }
      return {
        events: [{ type: 'story_started' }],
        result: st => ({
          ok: true, phase: 'idle', status_line: statusLine(st),
          player_intro: { title: st.title, role: st.script!.player, genre: st.script!.genre },
          brief: writerBrief(st, true),
          next_action: '只憑玩家已知資訊寫出開場：先呼叫 gmax_turn_begin（player_input 填「開場」），再走正常回合流程。開場算第 1 回合，不可替玩家行動。',
        }),
      };
    });
  }

  storyResume(storyId: string) {
    const s = this.store.state(storyId);
    return {
      ok: true, story_id: storyId, title: s.title, status: s.status,
      phase: s.current ? 'writing' : s.status === 'authoring' ? 'authoring' : 'idle',
      status_line: statusLine(s),
      settings: s.settings,
      script: s.status === 'authoring' ? scriptPacket(s) : undefined,
      brief: s.status === 'authoring' ? undefined : writerBrief(s, true),
      in_flight: s.current ? { turn: s.current.number, round: s.current.round, player_input: s.current.player_input } : undefined,
      next_action: s.current
        ? '有未完成的回合：呼叫 gmax_review_status 接續，或用 gmax_turn_abort 放棄。'
        : s.status === 'active'
          ? '等待玩家輸入後呼叫 gmax_turn_begin。需要時可用最後一回合內容回顧前情。'
          : '依目前狀態繼續。',
    };
  }

  scriptRead(storyId: string, section?: string) {
    const s = this.store.state(storyId);
    return { ok: true, script: scriptPacket(s, section), next_action: '僅供寫作參考，不可直接告訴玩家。' };
  }

  turnBegin(storyId: string, playerInput: string, playerFacts: { text: string; known_by?: string[] }[] = [], replace = false) {
    return this.store.mutate(storyId, s => {
      requireStatus(s, 'active', s.status === 'ended' ? '故事已結束。' : '請先呼叫 gmax_story_start。');
      const events: StoryEvent[] = [];
      if (s.current) {
        if (!replace) throw new GmaxError(`第 ${s.current.number} 回合尚未完成。`, '請接續完成，或帶 replace:true 改以新的玩家輸入重開此回合。');
        events.push({ type: 'turn_aborted' });
      }
      events.push({
        type: 'turn_begun',
        player_input: playerInput,
        player_facts: playerFacts.map(f => ({ text: f.text, known_by: f.known_by ?? ['player'] })),
      });
      return {
        events,
        result: st => ({
          ok: true, phase: 'writing', turn: st.current!.number,
          player_fact_ids: st.current!.player_fact_ids,
          status_line: statusLine(st),
          brief: writerBrief(st, false),
          next_action: '撰寫本段內容並填寫宣告，呼叫 gmax_draft_submit。此時不要向玩家輸出故事內容。玩家事實一律接受且不消耗參數。',
        }),
      };
    });
  }

  turnAbort(storyId: string) {
    return this.store.mutate(storyId, s => {
      requireCurrent(s);
      return {
        events: [{ type: 'turn_aborted' }],
        result: st => ({ ok: true, phase: 'idle', status_line: statusLine(st), next_action: '回合已放棄，本回合的玩家事實也已撤銷。' }),
      };
    });
  }

  draftSubmit(storyId: string, text: string, rawDeclaration: unknown, conservative = false) {
    const declaration = declarationSchema.parse(rawDeclaration);
    return this.store.mutate<object>(storyId, s => {
      const cur = requireCurrent(s);
      const round = cur.round + 1;
      const exhausted = round > s.settings.max_revisions + 1;

      if (conservative && !exhausted) {
        throw new GmaxError('尚未達修改上限，不可使用保守版。', '請依審查意見修改。');
      }
      if (exhausted && !conservative) {
        return {
          events: [],
          result: () => ({
            ok: false, phase: 'writing',
            problems: [`已達修改上限（${s.settings.max_revisions} 次）。`],
            next_action: '改寫成只推進已登記內容的保守版，宣告不含新事實以外的新增項目，並帶 conservative:true 重新提交。',
          }),
        };
      }

      const problems = checkDraft(s, text, declaration, conservative);
      if (problems.length > 0) {
        return {
          events: [],
          result: () => ({ ok: false, phase: 'writing', problems, next_action: '修正後重新呼叫 gmax_draft_submit。程式檢查失敗不計入修改次數。' }),
        };
      }

      const need = this.rolesToReview(s, text, declaration, conservative);
      const tickets = need.map(role => newTicket(role, round));
      const retained = (Object.keys(cur.results) as Role[]).filter(r => !need.includes(r) && cur.results[r]?.verdict === 'pass');
      return {
        events: [{ type: 'draft_submitted', text, declaration, conservative, tickets, retained }],
        result: () => ({
          ok: true, phase: 'reviewing', round,
          reviewers: describeTickets(tickets),
          retained_passes: retained,
          length: lengthReport(text, s.settings.length_per_turn),
          next_action: tickets.length > 0
            ? `在同一則訊息平行啟動 reviewers 列出的子代理，每個都要帶上 model 與 effort，提示詞只傳票證。${WAIT_RULE}回報全部完成後呼叫 gmax_review_status。`
            : '不需要審查，直接呼叫 gmax_turn_commit。',
        }),
      };
    });
  }

  private rolesToReview(s: StoryState, text: string, d: Declaration, conservative: boolean): Role[] {
    if (conservative) return [];
    const cur = s.current!;
    const all: Role[] = ['logic', 'ledger', 'registry'];
    if (d.characters_present.length > 0) all.push('character');
    if (cur.round === 0 || cur.text === undefined) return all;

    if (changeRatio(cur.text, text) > MAJOR_CHANGE_RATIO) return all;
    const declarationChanged = comparableDeclaration(cur.declaration) !== comparableDeclaration(d);
    const need = new Set<Role>();
    for (const role of all) {
      const result = cur.results[role];
      if (!result || result.verdict === 'reject') need.add(role);
    }
    if (declarationChanged) ['logic', 'ledger', 'registry'].forEach(r => need.add(r as Role));
    return all.filter(r => need.has(r));
  }

  reviewPacket(ticket: string, storyId: string) {
    const s = this.store.state(storyId);
    const t = s.current?.tickets.find(x => x.ticket === ticket) ?? s.script_tickets.find(x => x.ticket === ticket);
    if (!t) throw new GmaxError('票證不存在或已過期。', '請回報主代理。');
    return { ok: true, ...reviewPacket(s, t.role), next_action: '完成審查後呼叫 gmax_review_submit。最終回覆只寫它回傳的 reply_text，不要重述內容。' };
  }

  reviewSubmit(storyId: string, raw: unknown) {
    const input = reviewInput.parse(raw);
    return this.store.mutate(storyId, s => {
      const turnTicket = s.current?.tickets.find(x => x.ticket === input.ticket);
      const scriptTicket = s.script_tickets.find(x => x.ticket === input.ticket);
      const t = turnTicket ?? scriptTicket;
      if (!t) throw new GmaxError('票證不存在或已過期。', '草稿可能已被重新提交。');
      validateReview(t.role, input.issues, input.verdict, s, turnTicket ? s.current!.text : undefined);
      const result: ReviewResult = {
        verdict: input.verdict, issues: input.verdict === 'reject' ? input.issues : [], notes: input.notes, round: t.round,
      };
      const event: StoryEvent = turnTicket
        ? { type: 'review_recorded', role: t.role, result }
        : { type: 'script_review_recorded', role: t.role, result };
      return {
        events: [event],
        result: st => {
          const remaining = turnTicket
            ? st.current!.tickets.filter(x => !st.current!.results[x.role]).length
            : st.script_tickets.filter(x => !st.script_results[x.role]).length;
          return {
            ok: true, recorded: t.role, remaining,
            reply_text: remaining > 0 ? `已提交，還有 ${remaining} 項審查未完成` : '已提交，本輪審查全部完成',
            next_action: '已記錄。最終回覆只寫 reply_text，一字不改。',
          };
        },
      };
    });
  }

  reviewStatus(storyId: string) {
    const s = this.store.state(storyId);
    const cur = requireCurrent(s);
    const pending = cur.tickets.filter(t => !cur.results[t.role]);
    const rejected = Object.entries(cur.results).filter(([, r]) => r?.verdict === 'reject');
    const remaining = s.settings.max_revisions + 1 - cur.round;
    let next_action = '全部通過，呼叫 gmax_turn_commit。';
    if (cur.text === undefined) next_action = '尚未提交草稿，請呼叫 gmax_draft_submit。';
    else if (pending.length > 0) next_action = '等待或重新啟動尚未回報的審查子代理。';
    else if (rejected.length > 0) {
      next_action = remaining > 0
        ? `依問題修改後重新呼叫 gmax_draft_submit（還可修改 ${remaining} 次）。`
        : '修改次數用完，請寫保守版並帶 conservative:true 提交。';
    }
    return {
      ok: true, phase: 'reviewing', round: cur.round,
      pending: describeTickets(pending),
      issues: Object.fromEntries(rejected.map(([role, r]) => [role, r!.issues])),
      ready_to_commit: cur.text !== undefined && pending.length === 0 && rejected.length === 0,
      next_action,
    };
  }

  turnCommit(storyId: string) {
    return this.store.mutate(storyId, s => {
      const cur = requireCurrent(s);
      if (cur.text === undefined) throw new GmaxError('尚未提交草稿。', '請先呼叫 gmax_draft_submit。');
      const pending = cur.tickets.filter(t => !cur.results[t.role]);
      const rejected = Object.entries(cur.results).filter(([, r]) => r?.verdict === 'reject');
      if (pending.length > 0 || rejected.length > 0) {
        throw new GmaxError('審查尚未全部通過，不可提交。', '請呼叫 gmax_review_status 查看狀態。');
      }
      const text = cur.text;
      return {
        events: [{ type: 'turn_committed' }],
        result: st => ({
          ok: true, phase: 'idle', turn: st.turns.at(-1)!.number, degraded: cur.conservative,
          status_line: statusLine(st),
          final_text: text,
          next_action: storyReadyToEnd(st)
            ? '把 final_text 一字不改地輸出給玩家，不要附加審查過程或劇本資訊。必經節點與支線都已處理：如果這段已是結局，呼叫 gmax_story_end；否則等待玩家下一步。'
            : '把 final_text 一字不改地輸出給玩家，不要附加審查過程或劇本資訊。接著等待玩家下一步。',
        }),
      };
    });
  }

  turnRewind(storyId: string, toTurn: number) {
    return this.store.mutate(storyId, (s, events) => {
      if (s.status === 'authoring') throw new GmaxError('故事尚未開始。');
      const started = events.find(e => e.type === 'story_started');
      if (!started) throw new GmaxError('故事尚未開始。');
      let toSeq = started.seq;
      if (toTurn > 0) {
        // 必須以目前有效的時間線定位，避免回溯到已被取消的分支
        const live = this.liveCommits(events);
        const target = live[toTurn - 1];
        if (target === undefined) throw new GmaxError(`第 ${toTurn} 回合不存在。`);
        toSeq = target;
      }
      return {
        events: [{ type: 'rewound', to_seq: toSeq }],
        result: st => ({
          ok: true, phase: 'idle', turn: st.turns.at(-1)?.number ?? 0, status_line: statusLine(st),
          last_text: st.turns.at(-1)?.text,
          next_action: `已回到第 ${toTurn} 回合結束時，之後的事實與參數消耗都已還原。`,
        }),
      };
    });
  }

  private liveCommits(events: { seq: number; type: string; to_seq?: number }[]): number[] {
    let commits: number[] = [];
    for (const e of events) {
      if (e.type === 'turn_committed') commits.push(e.seq);
      if (e.type === 'rewound') commits = commits.filter(c => c <= e.to_seq!);
    }
    return commits;
  }

  storyStatus(storyId: string) {
    const s = this.store.state(storyId);
    const budgets = Object.fromEntries(Object.entries(budgetsOf(s)).map(([k, b]) => [k, { label: b.label, spent: b.spent, limit: b.limit }]));
    const rejected: Record<string, number> = {};
    for (const t of s.turns) for (const r of t.rejected_roles) rejected[r] = (rejected[r] ?? 0) + 1;
    const mustHit = Object.values(s.beats).filter(b => b.must_hit);
    return {
      ok: true, title: s.title, status: s.status, status_line: statusLine(s),
      turn: s.turns.at(-1)?.number ?? 0,
      budgets,
      progress: {
        act: s.script ? s.script.acts.findIndex(a => a.id === currentAct(s)?.id) + 1 : 0,
        acts: s.script?.acts.length ?? 0,
        beats_done: mustHit.filter(b => b.status !== 'pending').length,
        beats_total: mustHit.length,
        open_threads: Object.values(s.threads).filter(t => t.status === 'open').length,
      },
      known_facts: Object.values(s.facts).filter(f => f.player_known).map(f => ({ id: f.id, text: f.text, source: f.source })),
      quality: {
        revisions: s.turns.reduce((n, t) => n + t.rounds - 1, 0),
        script_issues_accepted: Object.values(s.script_results).filter(r => r?.verdict === 'reject').length,
        degraded_turns: s.turns.filter(t => t.degraded).length,
        rejections_by_role: rejected,
      },
      next_action: '此資料不含暴雷內容，可以告訴玩家。',
    };
  }

  storyEnd(storyId: string, endingId: string, force = false) {
    return this.store.mutate(storyId, s => {
      requireStatus(s, 'active', '只有進行中的故事可以結束。');
      if (s.current) throw new GmaxError('還有未完成的回合。', '請先提交或放棄。');
      if (!s.script!.endings.some(e => e.id === endingId) && !force) {
        throw new GmaxError(`結局不存在：${endingId}`);
      }
      const beats = Object.values(s.beats).filter(b => b.must_hit && b.status === 'pending').map(b => `節點 ${b.id}：${b.title}`);
      const threads = Object.values(s.threads).filter(t => t.status === 'open').map(t => `支線 ${t.id}：${t.title}`);
      if (!force && beats.length + threads.length > 0) {
        return {
          events: [],
          result: () => ({ ok: false, phase: 'idle', unresolved: [...beats, ...threads], next_action: '先在回合中處理這些項目；若玩家明確要提前結束，才帶 force:true。' }),
        };
      }
      return {
        events: [{ type: 'story_ended', ending_id: endingId }],
        result: () => ({ ok: true, phase: 'idle', next_action: '故事結束。可用 gmax_story_export 匯出；玩家想看幕後時才帶 include_script:true。' }),
      };
    });
  }

  storyExport(storyId: string, includeScript = false, confirmSpoilers = false) {
    const s = this.store.state(storyId);
    if (includeScript && s.status !== 'ended' && !confirmSpoilers) {
      throw new GmaxError('故事尚未結束，匯出劇本會暴雷。', '只有玩家明確同意時才帶 confirm_spoilers:true。');
    }
    const name = includeScript ? 'export-full.md' : 'export-story.md';
    const path = this.store.writeExport(storyId, name, exportMarkdown(s, includeScript));
    return { ok: true, path, next_action: '把檔案路徑告訴玩家，不要在對話中重述內容。' };
  }
}
