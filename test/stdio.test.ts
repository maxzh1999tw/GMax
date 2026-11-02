import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { script } from './fixtures.js';

let client: Client;
let home: string;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  return { ...JSON.parse(r.content[0]!.text), isError: r.isError };
};

beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  home = mkdtempSync(join(tmpdir(), 'gmax-stdio-'));
  client = new Client({ name: 't', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['plugin/server/gmax.mjs'],
    env: { ...process.env, GMAX_HOME: home } as Record<string, string>,
  }));
}, 60_000);

afterAll(() => client.close());

it('打包後的伺服器能走完整個回合', async () => {
  expect(client.getInstructions()).toContain('互動小說');
  const { tools } = await client.listTools();
  expect(tools.length).toBeGreaterThan(15);
  for (const t of tools) expect(t.inputSchema.type).toBe('object');

  const { story_id: id } = await call('gmax_story_create', { title: '雪夜' });
  const sub = await call('gmax_script_submit', { story_id: id, script: script() });
  expect(sub.next_action).toContain('票證');
  for (const r of sub.reviewers) {
    const packet = await call('gmax_review_packet', { story_id: id, ticket: r.ticket });
    expect(packet.checklist.length).toBeGreaterThan(0);
    await call('gmax_review_submit', { story_id: id, ticket: r.ticket, verdict: 'pass' });
  }
  expect((await call('gmax_story_start', { story_id: id })).ok).toBe(true);
  await call('gmax_turn_begin', { story_id: id, player_input: '開場' });
  const draft = await call('gmax_draft_submit', { story_id: id, text: '雪落無聲。', declaration: {} });
  for (const r of draft.reviewers) await call('gmax_review_submit', { story_id: id, ticket: r.ticket, verdict: 'pass' });
  const done = await call('gmax_turn_commit', { story_id: id });
  expect(done.final_text).toBe('雪落無聲。');
  expect(done.status_line).toContain('第 1 回合');

  const lines = readFileSync(join(home, 'stories', id, 'events.jsonl'), 'utf8').trim().split('\n');
  expect(lines.length).toBeGreaterThan(5);
}, 60_000);

it('不合法的輸入會回傳錯誤與提示，不會讓伺服器崩潰', async () => {
  const r = await client.callTool({ name: 'gmax_turn_commit', arguments: { story_id: 'nope' } }) as { isError: boolean };
  expect(r.isError).toBe(true);
  expect((await call('gmax_story_list')).ok).toBe(true);
});
