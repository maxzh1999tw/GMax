import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';

export const script = () => ({
  premise: '雪夜山莊，主人遇害。',
  genre: '懸疑',
  player: { role: '偵探' },
  characters: [
    { id: 'lin', name: '林管家', role: '管家', persona: '謹慎忠誠', voice: '恭敬簡短' },
    { id: 'chen', name: '陳醫生', role: '醫生', persona: '傲慢理性', voice: '夾帶術語' },
  ],
  relationships: [{ from: 'lin', to: 'chen', description: '互相猜忌' }],
  facts: [
    { id: 'killer', kind: 'truth', text: '陳醫生是兇手', known_by: ['chen'], secret: true },
    { id: 'clue1', kind: 'clue', text: '藥櫃少了一瓶毒藥', known_by: ['lin'], supports: ['killer'] },
    { id: 'clue2', kind: 'clue', text: '陳醫生袖口有藥漬', known_by: [], supports: ['killer'] },
    { id: 'snow', kind: 'setting', text: '大雪封山', known_by: ['*'], player_known: true },
  ],
  acts: [
    { id: 'a1', title: '案發', goal: '發現屍體', target_end_turn: 3 },
    { id: 'a2', title: '解謎', goal: '指認兇手', target_end_turn: 6 },
  ],
  beats: [
    { id: 'b1', act: 'a1', title: '發現屍體', description: '在書房發現主人', deadline_turn: 2 },
    { id: 'b2', act: 'a2', title: '指認', description: '揭露兇手', reveals: ['killer'] },
  ],
  threads: [{ id: 't1', title: '毒藥來源', description: '毒藥怎麼來的', resolve_by_act: 'a2' }],
  endings: [{ id: 'e1', title: '真相大白', conditions: '指認陳醫生', description: '陳醫生認罪' }],
});

export function newEngine(): Engine {
  return new Engine(new Store(mkdtempSync(join(tmpdir(), 'gmax-'))));
}

export function passAll(engine: Engine, id: string, reviewers: { ticket: string }[]): void {
  for (const r of reviewers) engine.reviewSubmit(id, { ticket: r.ticket, verdict: 'pass' });
}

export function activeStory(engine: Engine, overrides: object = {}): string {
  const { story_id: id } = engine.storyCreate('雪夜', overrides);
  const sub = engine.scriptSubmit(id, script()) as { reviewers: { ticket: string }[] };
  passAll(engine, id, sub.reviewers);
  engine.storyStart(id);
  return id;
}

export function playTurn(engine: Engine, id: string, text: string, declaration: object = {}, input = '調查'): void {
  engine.turnBegin(id, input);
  const sub = engine.draftSubmit(id, text, declaration) as unknown as { ok: boolean; reviewers: { ticket: string }[]; problems?: string[] };
  if (!sub.ok) throw new Error(sub.problems?.join());
  passAll(engine, id, sub.reviewers);
  engine.turnCommit(id);
}
