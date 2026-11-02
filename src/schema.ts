import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'ID 只能使用英數、底線與連字號');

export const budgetSchema = z.object({
  label: z.string().min(1),
  definition: z.string().min(1),
  limit: z.number().int().min(0),
});
export type Budget = z.infer<typeof budgetSchema>;

export const DEFAULT_BUDGETS: Record<string, Budget> = {
  twist: {
    label: '反轉',
    definition: '劇本未登記、由 AI 自行發想，且推翻玩家目前已建立認知的情節。',
    limit: 3,
  },
  info_patch: {
    label: '補充資訊',
    definition: '劇本未登記、由 AI 自行發想，會影響解讀或後續情節的新資訊。無害細節不算。',
    limit: 6,
  },
  misdirection: {
    label: '誤導',
    definition: '劇本未登記、由 AI 自行發想，刻意引導玩家得出錯誤結論的資訊。',
    limit: 3,
  },
  new_thread: {
    label: '新支線',
    definition: '劇本未登記、由 AI 自行開啟且之後需要收束的故事線。',
    limit: 2,
  },
  new_character: {
    label: '新角色',
    definition: '劇本未登記、由 AI 自行加入且具有劇情作用的角色。路人不算。',
    limit: 2,
  },
  retcon: {
    label: '改設定',
    definition: '並非因玩家事實所需，而由 AI 自行修改既有劇本或事實。',
    limit: 1,
  },
};

const preferenceFields = {
  language: z.string(),
  style: z.string(),
  pov: z.string(),
  length_per_turn: z.string(),
  player_profile: z.string(),
  content_boundaries: z.array(z.string()),
  budgets: z.record(z.string(), budgetSchema),
  max_revisions: z.number().int().min(0).max(10),
  min_clues_per_secret: z.number().int().min(0).max(10),
  target_turns: z.number().int().min(1).max(1000).describe('總回合數，含開場。開場是第 1 回合，玩家可行動 target_turns - 1 次'),
};

export const preferencesSchema = z.object({
  language: preferenceFields.language.default('繁體中文'),
  style: preferenceFields.style.default(''),
  pov: preferenceFields.pov.default(''),
  length_per_turn: preferenceFields.length_per_turn.default('300～600 字'),
  player_profile: preferenceFields.player_profile.default(''),
  content_boundaries: preferenceFields.content_boundaries.default([]),
  budgets: preferenceFields.budgets.default(DEFAULT_BUDGETS),
  max_revisions: preferenceFields.max_revisions.default(3),
  min_clues_per_secret: preferenceFields.min_clues_per_secret.default(2),
  target_turns: preferenceFields.target_turns.default(30),
});
export type Preferences = z.infer<typeof preferencesSchema>;
// 不可用 preferencesSchema.partial()：預設值會把未指定的欄位蓋回去
export const preferencesPatchSchema = z.object(preferenceFields).partial();

export const factKind = z.enum(['truth', 'setting', 'event', 'clue']);

const relationshipSchema = z.object({
  from: id, to: id, description: z.string().min(1),
});

const threadSchema = z.object({
  id,
  title: z.string().min(1),
  description: z.string().min(1),
  resolve_by_act: id.optional(),
});

export const scriptSchema = z.object({
  premise: z.string().min(1).describe('故事前提與世界背景'),
  genre: z.string().optional(),
  style_guide: z.string().optional().describe('本劇本專屬文風，僅供寫手參考，不作為退稿理由'),
  player: z.object({
    name: z.string().optional(),
    role: z.string().min(1),
    description: z.string().optional(),
  }),
  characters: z.array(z.object({
    id,
    name: z.string().min(1),
    role: z.string().min(1),
    persona: z.string().min(1).describe('性格與價值觀'),
    voice: z.string().min(1).describe('說話方式'),
    goals: z.array(z.string()).default([]),
    never: z.array(z.string()).default([]).describe('此角色絕不會做的事'),
    beliefs: z.array(z.object({ text: z.string(), about: id.optional() })).default([])
      .describe('此角色相信但可能錯誤的認知'),
  })).min(1),
  relationships: z.array(relationshipSchema).default([]),
  facts: z.array(z.object({
    id,
    kind: factKind,
    text: z.string().min(1).describe('一條事實只寫一件可單獨揭露的資訊；revealed_facts 只能整條揭露，物證與幕後真相要分開'),
    when: z.string().optional().describe('事件發生的時間點，供時間線檢查'),
    known_by: z.array(z.string()).default([]).describe('知情角色 ID；"*" 代表眾所皆知'),
    player_known: z.boolean().default(false),
    secret: z.boolean().default(false).describe('需要玩家透過線索發現的核心祕密'),
    supports: z.array(id).default([]).describe('線索指向哪些事實 ID'),
  })).min(1),
  acts: z.array(z.object({
    id,
    title: z.string().min(1),
    goal: z.string().min(1),
    target_end_turn: z.number().int().min(1),
  })).min(1),
  beats: z.array(z.object({
    id,
    act: id,
    title: z.string().min(1),
    description: z.string().min(1),
    must_hit: z.boolean().default(true),
    deadline_turn: z.number().int().min(1).optional(),
    reveals: z.array(id).default([]),
  })).min(1),
  threads: z.array(threadSchema).default([]),
  endings: z.array(z.object({
    id,
    title: z.string().min(1),
    conditions: z.string().min(1),
    description: z.string().min(1),
  })).min(1),
});
export type Script = z.infer<typeof scriptSchema>;

const { shape } = scriptSchema;
const removeIds = z.array(id);

/** 只改動部分劇本。upsert 以 ID 取代整個項目，沒有的就新增。 */
export const scriptPatchSchema = z.object({
  set: z.object({
    premise: shape.premise,
    genre: z.string(),
    style_guide: z.string(),
    player: shape.player,
    relationships: z.array(relationshipSchema),
  }).partial().optional(),
  upsert: z.object({
    characters: z.array(shape.characters.element),
    facts: z.array(shape.facts.element),
    acts: z.array(shape.acts.element),
    beats: z.array(shape.beats.element),
    threads: z.array(threadSchema),
    endings: z.array(shape.endings.element),
  }).partial().optional(),
  remove: z.object({
    characters: removeIds,
    facts: removeIds,
    acts: removeIds,
    beats: removeIds,
    threads: removeIds,
    endings: removeIds,
  }).partial().optional(),
});
export type ScriptPatch = z.infer<typeof scriptPatchSchema>;

const characterCard = z.object({
  id,
  name: z.string().min(1),
  role: z.string().min(1),
  persona: z.string().min(1),
  voice: z.string().min(1),
  goals: z.array(z.string()).default([]),
  never: z.array(z.string()).default([]),
  beliefs: z.array(z.object({ text: z.string(), about: id.optional() })).default([]),
});

export const declarationSchema = z.object({
  characters_present: z.array(id).default([]).describe('本段有出場或發言的角色 ID'),
  spends: z.array(z.object({
    budget: z.string().min(1),
    excerpt: z.string().min(1).describe('草稿中對應的原文片段'),
    reason: z.string().min(1),
  })).default([]).describe('AI 自行發想所消耗的參數；因玩家事實而必要的修改不用填'),
  new_facts: z.array(z.object({
    key: id,
    text: z.string().min(1),
    kind: factKind.default('setting'),
    basis: z.enum(['detail', 'player_consequence', 'spend']),
    cause_fact: id.optional().describe('basis=player_consequence 時，引發此事實的玩家事實 ID'),
    budget: z.string().optional().describe('basis=spend 時扣除的參數'),
    known_by: z.array(z.string()).default([]),
    player_known: z.boolean().default(true),
  })).default([]),
  revealed_facts: z.array(id).default([]).describe('本段向玩家揭露的既有事實 ID'),
  knowledge_updates: z.array(z.object({
    character: id,
    fact: z.string().min(1).describe('既有事實 ID，或 new:<key>'),
  })).default([]),
  new_characters: z.array(characterCard.extend({
    cause_fact: id.optional(),
  })).default([]).describe('沒有 cause_fact 時須消耗 new_character'),
  beat_updates: z.array(z.object({
    beat: id,
    status: z.enum(['hit', 'adapted', 'dropped']),
    note: z.string().min(1),
    cause_fact: id.optional(),
  })).default([]),
  threads_opened: z.array(z.object({
    key: id,
    title: z.string().min(1),
    description: z.string().min(1),
    resolve_by_act: id.optional(),
    cause_fact: id.optional(),
  })).default([]),
  threads_resolved: z.array(z.object({
    thread: id,
    status: z.enum(['resolved', 'abandoned']).default('resolved'),
    note: z.string().min(1),
  })).default([]),
  script_amendments: z.array(z.object({
    target: id.describe('要修改的事實、節點、支線或角色 ID'),
    new_text: z.string().min(1),
    reason: z.string().min(1),
    cause_fact: id.optional().describe('因玩家事實而必要時填寫，免費；否則須消耗 retcon'),
  })).default([]),
});
export type Declaration = z.infer<typeof declarationSchema>;

export const REVIEW_CATEGORIES = [
  'logic', 'fact', 'script', 'character', 'knowledge', 'budget', 'convergence', 'registration',
] as const;

export const reviewIssueSchema = z.object({
  category: z.enum(REVIEW_CATEGORIES).describe('文風不在此列，不得作為退稿理由'),
  excerpt: z.string().optional().describe('草稿中有問題的原文片段'),
  citations: z.array(z.string()).default([]).describe('依據的事實、角色、節點、支線、幕或參數 ID；可寫 su.never 指向欄位'),
  explanation: z.string().min(1),
  suggestion: z.string().min(1),
  budget_correction: z.object({
    budget: z.string(),
    should_spend: z.number().int().min(0),
  }).optional().describe('參數填錯時，此參數在這份草稿中應消耗的次數（不是累計）'),
});
export type ReviewIssue = z.infer<typeof reviewIssueSchema>;
