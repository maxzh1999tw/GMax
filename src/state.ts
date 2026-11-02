import type { Budget, Declaration, Preferences, ReviewIssue, Script } from './schema.js';

export type Role = 'logic' | 'character' | 'ledger' | 'registry' | 'script_logic' | 'script_drama';

export type Fact = {
  id: string;
  kind: string;
  text: string;
  when?: string;
  known_by: string[];
  player_known: boolean;
  secret: boolean;
  supports: string[];
  source: 'script' | 'player' | 'ai';
  turn: number;
  history: { text: string; turn: number; reason: string }[];
};

export type ReviewResult = {
  verdict: 'pass' | 'reject';
  issues: ReviewIssue[];
  notes: string;
  round: number;
};

export type Ticket = { ticket: string; role: Role; round: number };

export type CurrentTurn = {
  number: number;
  player_input: string;
  player_fact_ids: string[];
  round: number;
  text?: string;
  declaration?: Declaration;
  conservative: boolean;
  tickets: Ticket[];
  results: Partial<Record<Role, ReviewResult>>;
  rejected_roles: Role[];
  prior_issues: Partial<Record<Role, ReviewIssue[]>>;
};

export type CommittedTurn = {
  number: number;
  player_input: string;
  text: string;
  rounds: number;
  degraded: boolean;
  spends: Declaration['spends'];
  rejected_roles: Role[];
};

export type Beat = Script['beats'][number] & {
  status: 'pending' | 'hit' | 'adapted' | 'dropped';
  note?: string;
};
export type Thread = Script['threads'][number] & {
  status: 'open' | 'resolved' | 'abandoned';
  note?: string;
  turn: number;
};

export type StoryState = {
  id: string;
  title: string;
  status: 'authoring' | 'active' | 'ended';
  created_at: string;
  settings: Preferences;
  script?: Script;
  script_round: number;
  script_tickets: Ticket[];
  script_results: Partial<Record<Role, ReviewResult>>;
  script_prior_issues: Partial<Record<Role, ReviewIssue[]>>;
  script_changed: string[];
  characters: Record<string, Script['characters'][number]>;
  facts: Record<string, Fact>;
  beats: Record<string, Beat>;
  threads: Record<string, Thread>;
  spent: Record<string, number>;
  turns: CommittedTurn[];
  current?: CurrentTurn;
  fact_seq: number;
  ending_id?: string;
};

export type StoryEvent =
  | { type: 'story_created'; id: string; title: string; settings: Preferences; at: string }
  | { type: 'settings_updated'; settings: Preferences }
  | { type: 'script_submitted'; script: Script; tickets: Ticket[]; retained?: Role[]; changed?: string[] }
  | { type: 'script_final_fix'; script: Script }
  | { type: 'script_review_recorded'; role: Role; result: ReviewResult }
  | { type: 'story_started' }
  | { type: 'turn_begun'; player_input: string; player_facts: { text: string; known_by: string[] }[] }
  | { type: 'turn_aborted' }
  | { type: 'draft_submitted'; text: string; declaration: Declaration; conservative: boolean; tickets: Ticket[]; retained: Role[] }
  | { type: 'review_recorded'; role: Role; result: ReviewResult }
  | { type: 'turn_committed' }
  | { type: 'story_ended'; ending_id: string }
  | { type: 'rewound'; to_seq: number };

export type LoggedEvent = StoryEvent & { seq: number; ts: string };

function blank(): StoryState {
  return {
    id: '', title: '', status: 'authoring', created_at: '',
    settings: {} as Preferences,
    script_round: 0, script_tickets: [], script_results: {}, script_prior_issues: {}, script_changed: [],
    characters: {}, facts: {}, beats: {}, threads: {},
    spent: {}, turns: [], fact_seq: 0,
  };
}

function loadScript(s: StoryState, script: Script): void {
  s.script = script;
  s.characters = Object.fromEntries(script.characters.map(c => [c.id, c]));
  s.facts = Object.fromEntries(script.facts.map(f => [f.id, {
    id: f.id, kind: f.kind, text: f.text, when: f.when, known_by: f.known_by,
    player_known: f.player_known, secret: f.secret, supports: f.supports,
    source: 'script' as const, turn: 0, history: [],
  }]));
  s.beats = Object.fromEntries(script.beats.map(b => [b.id, { ...b, status: 'pending' as const }]));
  s.threads = Object.fromEntries(script.threads.map(t => [t.id, { ...t, status: 'open' as const, turn: 0 }]));
}

/** 產生不會與劇本作者自訂 ID 衝突的事實 ID。 */
function nextFactId(s: StoryState, prefix: string): string {
  let id: string;
  do { id = `${prefix}${++s.fact_seq}`; } while (s.facts[id]);
  return id;
}

function commit(s: StoryState): void {
  const cur = s.current!;
  const d = cur.declaration!;
  const turn = cur.number;
  const newIds: Record<string, string> = {};

  for (const spend of d.spends) s.spent[spend.budget] = (s.spent[spend.budget] ?? 0) + 1;

  for (const f of d.new_facts) {
    const id = nextFactId(s, 'F');
    newIds[f.key] = id;
    s.facts[id] = {
      id, kind: f.kind, text: f.text, known_by: f.known_by, player_known: f.player_known,
      secret: false, supports: [], source: 'ai', turn, history: [],
    };
  }
  for (const id of d.revealed_facts) {
    const fact = s.facts[id];
    if (fact) fact.player_known = true;
  }
  for (const k of d.knowledge_updates) {
    const id = k.fact.startsWith('new:') ? newIds[k.fact.slice(4)] : k.fact;
    const fact = id ? s.facts[id] : undefined;
    if (fact && k.character === 'player') fact.player_known = true;
    if (fact && !fact.known_by.includes(k.character)) fact.known_by.push(k.character);
  }
  for (const c of d.new_characters) {
    const { cause_fact: _cause, ...card } = c;
    s.characters[c.id] = card;
  }
  for (const b of d.beat_updates) {
    const beat = s.beats[b.beat];
    if (beat) { beat.status = b.status; beat.note = b.note; }
  }
  for (const t of d.threads_opened) {
    s.threads[t.key] = {
      id: t.key, title: t.title, description: t.description, resolve_by_act: t.resolve_by_act,
      status: 'open', turn,
    };
  }
  for (const t of d.threads_resolved) {
    const thread = s.threads[t.thread];
    if (thread) { thread.status = t.status; thread.note = t.note; }
  }
  for (const a of d.script_amendments) {
    const fact = s.facts[a.target];
    if (fact) {
      fact.history.push({ text: fact.text, turn, reason: a.reason });
      fact.text = a.new_text;
    } else if (s.beats[a.target]) {
      s.beats[a.target]!.description = a.new_text;
    } else if (s.threads[a.target]) {
      s.threads[a.target]!.description = a.new_text;
    } else if (s.characters[a.target]) {
      s.characters[a.target]!.persona = a.new_text;
    }
  }

  s.turns.push({
    number: turn,
    player_input: cur.player_input,
    text: cur.text!,
    rounds: cur.round,
    degraded: cur.conservative,
    spends: d.spends,
    rejected_roles: cur.rejected_roles,
  });
  s.current = undefined;
}

function apply(s: StoryState, e: StoryEvent): void {
  switch (e.type) {
    case 'story_created':
      s.id = e.id; s.title = e.title; s.settings = e.settings; s.created_at = e.at;
      break;
    case 'settings_updated':
      s.settings = e.settings;
      break;
    case 'script_submitted':
      loadScript(s, e.script);
      s.status = 'authoring';
      s.script_round += 1;
      s.script_tickets = e.tickets;
      s.script_prior_issues = Object.fromEntries(
        Object.entries(s.script_results).filter(([, r]) => r?.verdict === 'reject').map(([role, r]) => [role, r!.issues]),
      );
      s.script_changed = e.changed ?? [];
      s.script_results = Object.fromEntries(
        (e.retained ?? []).map(r => [r, s.script_results[r]!]),
      ) as StoryState['script_results'];
      break;
    case 'script_final_fix':
      loadScript(s, e.script);
      break;
    case 'script_review_recorded':
      s.script_results[e.role] = e.result;
      break;
    case 'story_started':
      s.status = 'active';
      break;
    case 'turn_begun': {
      const ids: string[] = [];
      const number = (s.turns.at(-1)?.number ?? 0) + 1;
      for (const f of e.player_facts) {
        const id = nextFactId(s, 'P');
        ids.push(id);
        s.facts[id] = {
          id, kind: 'setting', text: f.text, known_by: f.known_by, player_known: true,
          secret: false, supports: [], source: 'player', turn: number, history: [],
        };
      }
      s.current = {
        number, player_input: e.player_input, player_fact_ids: ids,
        round: 0, conservative: false, tickets: [], results: {}, rejected_roles: [], prior_issues: {},
      };
      break;
    }
    case 'turn_aborted':
      if (s.current) {
        for (const id of s.current.player_fact_ids) delete s.facts[id];
      }
      s.current = undefined;
      break;
    case 'draft_submitted': {
      const cur = s.current!;
      cur.prior_issues = Object.fromEntries(
        Object.entries(cur.results).filter(([, r]) => r?.verdict === 'reject').map(([role, r]) => [role, r!.issues]),
      );
      cur.round += 1;
      cur.text = e.text;
      cur.declaration = e.declaration;
      cur.conservative = e.conservative;
      cur.tickets = e.tickets;
      cur.results = Object.fromEntries(
        e.retained.map(r => [r, cur.results[r]!]),
      ) as CurrentTurn['results'];
      break;
    }
    case 'review_recorded':
      s.current!.results[e.role] = e.result;
      if (e.result.verdict === 'reject' && !s.current!.rejected_roles.includes(e.role)) s.current!.rejected_roles.push(e.role);
      break;
    case 'turn_committed':
      commit(s);
      break;
    case 'story_ended':
      s.status = 'ended';
      s.ending_id = e.ending_id;
      break;
    case 'rewound':
      break;
  }
}

export function reduce(events: LoggedEvent[]): StoryState {
  let state = blank();
  for (const event of events) {
    if (event.type === 'rewound') {
      state = reduce(events.filter(x => x.seq <= event.to_seq));
    } else {
      apply(state, event);
    }
  }
  return state;
}

export function budgetsOf(s: StoryState): Record<string, Budget & { spent: number; remaining: number }> {
  return Object.fromEntries(Object.entries(s.settings.budgets).map(([key, b]) => {
    const spent = s.spent[key] ?? 0;
    return [key, { ...b, spent, remaining: b.limit - spent }];
  }));
}

export function currentAct(s: StoryState) {
  const acts = s.script?.acts ?? [];
  const pending = (actId: string) =>
    Object.values(s.beats).some(b => b.act === actId && b.must_hit && b.status === 'pending');
  return acts.find(a => pending(a.id)) ?? acts.at(-1);
}

export function isFinalAct(s: StoryState): boolean {
  const act = currentAct(s);
  return !!act && act.id === s.script?.acts.at(-1)?.id;
}

export function statusLine(s: StoryState): string {
  const turn = s.current?.number ?? s.turns.at(-1)?.number ?? 0;
  const budgets = Object.values(budgetsOf(s)).map(b => `${b.label} ${b.spent}/${b.limit}`);
  return [`GMax 第 ${turn} 回合`, ...budgets].join('｜');
}
