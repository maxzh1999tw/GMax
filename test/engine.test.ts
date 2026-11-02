import { describe, expect, it } from 'vitest';
import { AGENTS } from '../scripts/agents.mjs';
import { changeRatio, REVIEWERS } from '../src/engine.js';
import { activeStory, newEngine, passAll, playTurn, script } from './fixtures.js';

type Sub = { ok: boolean; problems: string[]; errors: string[]; reviewers: { ticket: string; role: string; agent: string; model: string; effort: string }[]; retained_passes: string[]; warnings: string[]; next_action: string; length: { chars: number; warning?: string } };

describe('劇本', () => {
  it('結構錯誤會擋下，不發票證', () => {
    const e = newEngine();
    const { story_id: id } = e.storyCreate('t');
    const bad = script();
    bad.beats[0]!.act = 'nope';
    bad.facts[1]!.supports = [];
    const r = e.scriptSubmit(id, bad) as unknown as Sub;
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('不存在的幕');
    expect(r.errors.join()).toContain('線索');
  });

  it('審查未通過不能開始，修改後可以', () => {
    const e = newEngine();
    const { story_id: id } = e.storyCreate('t');
    let r = e.scriptSubmit(id, script()) as unknown as Sub;
    expect(() => e.storyStart(id)).toThrow('尚未完成');
    e.reviewSubmit(id, { ticket: r.reviewers[0]!.ticket, verdict: 'reject', issues: [{ category: 'logic', citations: ['killer'], explanation: 'x', suggestion: 'y' }] });
    e.reviewSubmit(id, { ticket: r.reviewers[1]!.ticket, verdict: 'pass' });
    expect(() => e.storyStart(id)).toThrow('未通過');
    r = e.scriptSubmit(id, script()) as unknown as Sub;
    passAll(e, id, r.reviewers);
    expect(e.storyStart(id).ok).toBe(true);
  });

  const rejectLogic = (e: ReturnType<typeof newEngine>, id: string, r: Sub) => {
    for (const t of r.reviewers) {
      e.reviewSubmit(id, t.role === 'script_logic'
        ? { ticket: t.ticket, verdict: 'reject', issues: [{ category: 'logic', citations: ['killer'], explanation: 'x', suggestion: 'y' }] }
        : { ticket: t.ticket, verdict: 'pass' });
    }
  };

  it('每張票證都列出模型與思考程度，而且和子代理預設一致', () => {
    const e = newEngine();
    const { story_id: id } = e.storyCreate('t');
    const r = e.scriptSubmit(id, script()) as unknown as Sub;
    expect(r.reviewers.find(x => x.role === 'script_logic')).toMatchObject({ model: 'opus', effort: 'high' });
    expect(r.reviewers.find(x => x.role === 'script_drama')).toMatchObject({ model: 'sonnet', effort: 'medium' });
    for (const role of ['logic', 'ledger', 'character', 'registry'] as const) {
      const { agent, model, effort } = REVIEWERS[role];
      expect(AGENTS.find(a => a.name === agent)).toMatchObject({ model, effort });
    }
  });

  it('局部修改只重審被否決者，重審資料只含舊問題與改動處', () => {
    const e = newEngine();
    const { story_id: id } = e.storyCreate('t');
    rejectLogic(e, id, e.scriptSubmit(id, script()) as unknown as Sub);
    const r = e.scriptPatch(id, { upsert: { facts: [{ id: 'clue2', kind: 'clue', text: '袖口有新藥漬', supports: ['killer'] }] } }) as unknown as Sub;
    expect(r.reviewers.map(x => x.role)).toEqual(['script_logic']);
    expect(r.retained_passes).toEqual(['script_drama']);
    const packet = e.reviewPacket(r.reviewers[0]!.ticket, id) as unknown as { changed_ids: string[]; previous_issues: unknown[]; ground_rules: string[] };
    expect(packet.changed_ids).toEqual(['clue2']);
    expect(packet.previous_issues).toHaveLength(1);
    expect(packet.ground_rules.join()).toContain('重新審查');
    passAll(e, id, r.reviewers);
    expect(e.storyStart(id).ok).toBe(true);
    expect(e.store.state(id).facts.clue2!.text).toBe('袖口有新藥漬');
  });

  it('局部修改也會檢查結構，刪除還被引用的項目會被擋下', () => {
    const e = newEngine();
    const { story_id: id } = e.storyCreate('t');
    e.scriptSubmit(id, script());
    const r = e.scriptPatch(id, { remove: { facts: ['killer'] } }) as unknown as Sub;
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('不存在');
  });

  it('大幅修改時全部重審', () => {
    const e = newEngine();
    const { story_id: id } = e.storyCreate('t');
    rejectLogic(e, id, e.scriptSubmit(id, script()) as unknown as Sub);
    const r = e.scriptPatch(id, { upsert: { facts: script().facts.map(f => ({ ...f, text: `${f.text}！` })), beats: script().beats.map(b => ({ ...b, title: `${b.title}！` })) } }) as unknown as Sub;
    expect(r.reviewers).toHaveLength(2);
  });

  it('修改上限到了之後，修正直接套用不再送審', () => {
    const e = newEngine();
    const { story_id: id } = e.storyCreate('t', { max_revisions: 0 });
    rejectLogic(e, id, e.scriptSubmit(id, script()) as unknown as Sub);
    expect(e.scriptReviewStatus(id).next_action).toContain('不會再送審');
    expect(() => e.storyStart(id)).toThrow('未通過');
    const r = e.scriptPatch(id, { set: { premise: '新前提' } }) as unknown as Sub;
    expect(r.reviewers).toEqual([]);
    expect(r.next_action).toContain('accept_issues');
    expect(e.store.state(id).script!.premise).toBe('新前提');
    expect(e.storyStart(id, true).ok).toBe(true);
    expect(e.storyStatus(id).quality.script_issues_accepted).toBe(1);
  });

  it('開場算第 1 回合：期限設在開場會警告，開局也會說明', () => {
    const e = newEngine();
    const created = e.storyCreate('t', { target_turns: 4 });
    expect(created.turn_rule).toContain('玩家可行動 3 次');
    const sc = script();
    sc.beats[0]!.deadline_turn = 1;
    const r = e.scriptSubmit(created.story_id, sc) as unknown as Sub;
    expect(r.warnings.join()).toContain('開場');
    passAll(e, created.story_id, r.reviewers);
    e.storyStart(created.story_id);
    const brief = e.turnBegin(created.story_id, '開場').brief as { directives: string[] };
    expect(brief.directives.join()).toContain('這是開場');
  });
});

describe('回合', () => {
  it('未通過審查不能提交，通過後才扣參數', () => {
    const e = newEngine();
    const id = activeStory(e);
    e.turnBegin(id, '搜書房');
    const text = '門後竟站著已死的主人。';
    const r = e.draftSubmit(id, text, { spends: [{ budget: 'twist', excerpt: '已死的主人', reason: '反轉' }] }) as unknown as Sub;
    expect(r.ok).toBe(true);
    expect(() => e.turnCommit(id)).toThrow('尚未全部通過');
    expect(e.store.state(id).spent.twist).toBeUndefined();
    passAll(e, id, r.reviewers);
    const done = e.turnCommit(id);
    expect(done.final_text).toBe(text);
    expect(e.store.state(id).spent.twist).toBe(1);
  });

  it('沒有出場角色時不派人物審查，有角色才派', () => {
    const e = newEngine();
    const id = activeStory(e);
    e.turnBegin(id, 'x');
    let r = e.draftSubmit(id, '雪。', {}) as unknown as Sub;
    expect(r.reviewers.map(x => x.role).sort()).toEqual(['ledger', 'logic', 'registry']);
    passAll(e, id, r.reviewers);
    e.turnCommit(id);
    e.turnBegin(id, 'y');
    r = e.draftSubmit(id, '林管家點頭。', { characters_present: ['lin'] }) as unknown as Sub;
    expect(r.reviewers.map(x => x.agent)).toContain('gmax-character-reviewer');
  });

  it('參數超支與不實引用會被程式擋下', () => {
    const e = newEngine();
    const id = activeStory(e);
    e.turnBegin(id, 'x');
    const twist = (excerpt: string) => ({ budget: 'twist', excerpt, reason: 'r' });
    let r = e.draftSubmit(id, 'abc', { spends: [twist('不存在')] }) as unknown as Sub;
    expect(r.problems.join()).toContain('不在草稿');
    r = e.draftSubmit(id, 'abc', { spends: [twist('a'), twist('b'), twist('c'), twist('abc')] }) as unknown as Sub;
    expect(r.problems.join()).toContain('額度不足');
  });

  it('玩家事實一律接受且免費，由它引發的修改也免費', () => {
    const e = newEngine();
    const id = activeStory(e);
    const b = e.turnBegin(id, '其實我就是兇手', [{ text: '玩家才是兇手' }]);
    const pid = b.player_fact_ids[0]!;
    const r = e.draftSubmit(id, '你握緊了藏在袖中的藥瓶。', {
      script_amendments: [{ target: 'killer', new_text: '玩家是兇手', reason: '玩家宣告', cause_fact: pid }],
    }) as unknown as Sub;
    expect(r.ok).toBe(true);
    passAll(e, id, r.reviewers);
    e.turnCommit(id);
    const s = e.store.state(id);
    expect(Object.values(s.spent).reduce((a, n) => a + n, 0)).toBe(0);
    expect(s.facts.killer!.text).toBe('玩家是兇手');
    expect(s.facts.killer!.history[0]!.text).toBe('陳醫生是兇手');
    expect(s.facts[pid]!.source).toBe('player');
  });

  it('AI 自行修改設定必須消耗 retcon', () => {
    const e = newEngine();
    const id = activeStory(e);
    e.turnBegin(id, 'x');
    const amend = { target: 'killer', new_text: '林管家是兇手', reason: 'AI 想改' };
    let r = e.draftSubmit(id, '其實是林管家。', { script_amendments: [amend] }) as unknown as Sub;
    expect(r.problems.join()).toContain('retcon');
    r = e.draftSubmit(id, '其實是林管家。', { script_amendments: [amend], spends: [{ budget: 'retcon', excerpt: '林管家', reason: '改兇手' }] }) as unknown as Sub;
    expect(r.ok).toBe(true);
  });

  it('cause_fact 不能冒用非玩家事實', () => {
    const e = newEngine();
    const id = activeStory(e);
    e.turnBegin(id, 'x');
    const r = e.draftSubmit(id, 'a', { new_facts: [{ key: 'k', text: 't', basis: 'player_consequence', cause_fact: 'snow' }] }) as unknown as Sub;
    expect(r.problems.join()).toContain('不是玩家事實');
  });

  it('最後一幕不可自行開支線，逾期節點必須處理', () => {
    const e = newEngine();
    const id = activeStory(e);
    playTurn(e, id, '一', { beat_updates: [{ beat: 'b1', status: 'hit', note: 'n' }] });
    e.turnBegin(id, 'x');
    const r = e.draftSubmit(id, '新線', {
      threads_opened: [{ key: 'n', title: 'n', description: 'd' }],
      spends: [{ budget: 'new_thread', excerpt: '新線', reason: 'r' }],
    }) as unknown as Sub;
    expect(r.problems.join()).toContain('最後一幕');

    const e2 = newEngine();
    const id2 = activeStory(e2);
    playTurn(e2, id2, '一');
    playTurn(e2, id2, '二');
    e2.turnBegin(id2, 'x');
    const r2 = e2.draftSubmit(id2, '三', {}) as unknown as Sub;
    expect(r2.problems.join()).toContain('已逾期');
  });

  it('修改後只重審被否決者；大改或宣告變動才擴大', () => {
    const e = newEngine();
    const id = activeStory(e);
    e.turnBegin(id, 'x');
    const para = '第一段很長的內容，這段不會更動，所以比例會很小。'.repeat(5);
    let r = e.draftSubmit(id, `${para}\n林管家低頭。`, { characters_present: ['lin'] }) as unknown as Sub;
    for (const t of r.reviewers) {
      e.reviewSubmit(id, t.role === 'character'
        ? { ticket: t.ticket, verdict: 'reject', issues: [{ category: 'character', citations: ['lin'], explanation: 'x', suggestion: 'y' }] }
        : { ticket: t.ticket, verdict: 'pass' });
    }
    expect((e.reviewStatus(id).issues as Record<string, unknown>).character).toBeDefined();
    r = e.draftSubmit(id, `${para}\n林管家鞠躬。`, { characters_present: ['lin'] }) as unknown as Sub;
    expect(r.reviewers.map(x => x.role)).toEqual(['character']);
    expect(JSON.stringify(e.reviewPacket(r.reviewers[0]!.ticket, id))).toContain('previous_issues');
    expect(r.retained_passes.sort()).toEqual(['ledger', 'logic', 'registry']);
    expect(changeRatio('甲\n乙', '丙\n丁')).toBe(1);
  });

  it('只改節點說明不算宣告變動，字數超標只提醒', () => {
    const e = newEngine();
    const id = activeStory(e, { length_per_turn: '1～3 字' });
    e.turnBegin(id, 'x');
    const para = '第一段很長的內容，這段不會更動，所以比例會很小。'.repeat(5);
    const decl = (note: string) => ({ characters_present: ['lin'], beat_updates: [{ beat: 'b1', status: 'hit', note }] });
    let r = e.draftSubmit(id, `${para}\n林管家低頭。`, decl('甲')) as unknown as Sub;
    expect(r.ok).toBe(true);
    expect(r.length.warning).toContain('超過目標');
    for (const t of r.reviewers) {
      e.reviewSubmit(id, t.role === 'character'
        ? { ticket: t.ticket, verdict: 'reject', issues: [{ category: 'character', citations: ['lin'], explanation: 'x', suggestion: 'y' }] }
        : { ticket: t.ticket, verdict: 'pass' });
    }
    r = e.draftSubmit(id, `${para}\n林管家鞠躬。`, decl('乙')) as unknown as Sub;
    expect(r.reviewers.map(x => x.role)).toEqual(['character']);
  });

  it('審查回報會說明還剩幾項', () => {
    const e = newEngine();
    const id = activeStory(e);
    e.turnBegin(id, 'x');
    const r = e.draftSubmit(id, '雪。', {}) as unknown as Sub;
    const replies = r.reviewers.map(t => e.reviewSubmit(id, { ticket: t.ticket, verdict: 'pass' }) as unknown as { reply_text: string; remaining: number });
    expect(replies.map(x => x.remaining)).toEqual([2, 1, 0]);
    expect(replies[0]!.reply_text).toBe('已提交，還有 2 項審查未完成');
    expect(replies[2]!.reply_text).toBe('已提交，本輪審查全部完成');
  });

  it('參數審查者看得到角色的身分設定', () => {
    const e = newEngine();
    const id = activeStory(e);
    e.turnBegin(id, 'x');
    const r = e.draftSubmit(id, '雪。', {}) as unknown as Sub;
    const t = r.reviewers.find(x => x.role === 'ledger')!;
    expect(JSON.stringify(e.reviewPacket(t.ticket, id))).toContain('謹慎忠誠');
  });

  it('超過修改上限只能用保守版，且標記為降級', () => {
    const e = newEngine();
    const id = activeStory(e, { max_revisions: 1 });
    e.turnBegin(id, 'x');
    const reject = (t: { ticket: string }) => e.reviewSubmit(id, { ticket: t.ticket, verdict: 'reject', issues: [{ category: 'logic', citations: ['snow'], explanation: 'x', suggestion: 'y' }] });
    for (let i = 0; i < 2; i++) (e.draftSubmit(id, `第${i}版`, {}) as unknown as Sub).reviewers.forEach(reject);
    expect((e.draftSubmit(id, '第三版', {}) as unknown as Sub).ok).toBe(false);
    const bad = e.draftSubmit(id, '保守', { spends: [{ budget: 'twist', excerpt: '保守', reason: 'r' }] }, true) as unknown as Sub;
    expect(bad.problems.join()).toContain('保守版');
    expect((e.draftSubmit(id, '保守', {}, true) as unknown as Sub).reviewers).toEqual([]);
    expect(e.turnCommit(id).degraded).toBe(true);
    expect(e.storyStatus(id).quality.degraded_turns).toBe(1);
  });

  it('過期票證與無依據的退稿會被拒絕', () => {
    const e = newEngine();
    const id = activeStory(e);
    e.turnBegin(id, 'x');
    const first = e.draftSubmit(id, '甲', {}) as unknown as Sub;
    const t = first.reviewers[0]!.ticket;
    expect(() => e.reviewSubmit(id, { ticket: t, verdict: 'reject' })).toThrow('至少');
    expect(() => e.reviewSubmit(id, { ticket: t, verdict: 'reject', issues: [{ category: 'logic', explanation: 'x', suggestion: 'y' }] })).toThrow('必須引用');
    expect(() => e.reviewSubmit(id, { ticket: t, verdict: 'reject', issues: [{ category: 'logic', citations: ['ghost'], explanation: 'x', suggestion: 'y' }] })).toThrow('不存在');
    expect(e.reviewSubmit(id, { ticket: t, verdict: 'reject', issues: [{ category: 'character', citations: ['lin.never'], explanation: 'x', suggestion: 'y' }] }).ok).toBe(true);
    e.draftSubmit(id, '完全不同的乙', {});
    expect(() => e.reviewSubmit(id, { ticket: t, verdict: 'pass' })).toThrow('過期');
  });
});

describe('防雷與知識範圍', () => {
  it('人物審查者看不到角色知識範圍外的事實', () => {
    const e = newEngine();
    const id = activeStory(e);
    e.turnBegin(id, 'x');
    const r = e.draftSubmit(id, '林管家點頭。', { characters_present: ['lin'] }) as unknown as Sub;
    const t = r.reviewers.find(x => x.role === 'character')!;
    const packet = JSON.stringify(e.reviewPacket(t.ticket, id));
    expect(packet).toContain('藥櫃少了一瓶毒藥');
    expect(packet).toContain('大雪封山');
    expect(packet).not.toContain('陳醫生是兇手');
  });

  it('給玩家的狀態不含未揭露內容，揭露後才出現', () => {
    const e = newEngine();
    const id = activeStory(e);
    expect(JSON.stringify(e.storyStatus(id))).not.toContain('兇手');
    playTurn(e, id, '你看見藥櫃缺了一瓶。', { revealed_facts: ['clue1'] });
    expect(JSON.stringify(e.storyStatus(id))).toContain('藥櫃');
  });

  it('玩家也可以出現在知識更新中', () => {
    const e = newEngine();
    const id = activeStory(e);
    playTurn(e, id, '藥櫃', { knowledge_updates: [{ character: 'player', fact: 'clue1' }] });
    expect(e.store.state(id).facts.clue1!.player_known).toBe(true);
  });

  it('未結束前匯出劇本需要明確同意', () => {
    const e = newEngine();
    const id = activeStory(e);
    expect(() => e.storyExport(id, true)).toThrow('暴雷');
    expect(e.storyExport(id).path).toContain('export-story.md');
    expect(e.storyExport(id, true, true).path).toContain('export-full.md');
  });
});

describe('回溯與結局', () => {
  it('回溯會還原事實與參數，且可以分支後再回溯', () => {
    const e = newEngine();
    const id = activeStory(e);
    playTurn(e, id, '一', { beat_updates: [{ beat: 'b1', status: 'hit', note: 'n' }] });
    playTurn(e, id, '二反轉', { spends: [{ budget: 'twist', excerpt: '反轉', reason: 'r' }], new_facts: [{ key: 'k', text: '新事實', basis: 'spend', budget: 'twist' }] });
    expect(e.store.state(id).spent.twist).toBe(1);
    e.turnRewind(id, 1);
    let s = e.store.state(id);
    expect(s.turns).toHaveLength(1);
    expect(s.spent.twist).toBeUndefined();
    expect(Object.values(s.facts).some(f => f.text === '新事實')).toBe(false);
    playTurn(e, id, '分支二');
    playTurn(e, id, '分支三');
    e.turnRewind(id, 2);
    s = e.store.state(id);
    expect(s.turns.map(t => t.text)).toEqual(['一', '分支二']);
    e.turnRewind(id, 0);
    expect(e.store.state(id).turns).toHaveLength(0);
  });

  it('放棄回合會撤銷玩家事實', () => {
    const e = newEngine();
    const id = activeStory(e);
    const b = e.turnBegin(id, 'x', [{ text: '我有鑰匙' }]);
    e.turnAbort(id);
    expect(e.store.state(id).facts[b.player_fact_ids[0]!]).toBeUndefined();
    expect(() => e.turnCommit(id)).toThrow('沒有進行中');
  });

  it('未收束不能結束，收束後或強制可以', () => {
    const e = newEngine();
    const id = activeStory(e);
    const r = e.storyEnd(id, 'e1') as unknown as { ok: boolean; unresolved: string[] };
    expect(r.ok).toBe(false);
    expect(r.unresolved).toHaveLength(3);
    playTurn(e, id, '收束', {
      beat_updates: [{ beat: 'b1', status: 'hit', note: 'n' }, { beat: 'b2', status: 'hit', note: 'n' }],
      threads_resolved: [{ thread: 't1', note: 'n' }],
    });
    expect(e.storyEnd(id, 'e1').ok).toBe(true);
    expect(() => e.turnBegin(id, 'x')).toThrow('ended');
  });

  it('全域預設與單一故事設定互相獨立', () => {
    const e = newEngine();
    e.preferencesUpdate({ style: '冷硬' });
    const { story_id: id } = e.storyCreate('t', { max_revisions: 1 });
    expect(e.store.state(id).settings.style).toBe('冷硬');
    e.preferencesUpdate({ style: '輕鬆' });
    expect(e.store.state(id).settings.style).toBe('冷硬');
    e.settingsUpdate(id, { style: '詩意' });
    expect(e.store.state(id).settings.style).toBe('詩意');
    expect(e.store.preferences().style).toBe('輕鬆');
    expect(e.store.preferences().max_revisions).toBe(3);
  });

  it('自訂事實 ID 不會與自動產生的衝突', () => {
    const e = newEngine();
    const { story_id: id } = e.storyCreate('t');
    const sc = script();
    sc.facts.push({ id: 'P1', kind: 'setting', text: '既有', known_by: [] } as never);
    passAll(e, id, (e.scriptSubmit(id, sc) as unknown as Sub).reviewers);
    e.storyStart(id);
    const b = e.turnBegin(id, 'x', [{ text: '新' }]);
    expect(b.player_fact_ids[0]).not.toBe('P1');
    expect(e.store.state(id).facts.P1!.text).toBe('既有');
  });

  it('拒絕路徑穿越的 story_id', () => {
    expect(() => newEngine().storyStatus('../evil')).toThrow('無效');
  });
});
