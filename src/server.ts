import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Engine, hostOf } from './engine.js';
import { declarationSchema, preferencesPatchSchema, reviewIssueSchema, scriptPatchSchema, scriptSchema } from './schema.js';
import { GmaxError, Store } from './store.js';

const INSTRUCTIONS = `GMax 是文字互動小說的輔助工具。當使用者想玩文字冒險、互動小說、角色扮演或跑團時使用。
先和玩家正常討論想玩什麼，談定後再用 gmax_story_create 開始；玩家隨時可以跳出故事閒聊，那些對話不用經過這裡。
防雷規則：工具回傳的劇本與審查內容不可出現在給玩家的文字裡，呼叫審查子代理時提示詞只傳票證，並依 next_action 帶上 reviewers 列出的 model 與 effort。
每個回應都有 next_action，照著做即可。若有 gmax-play skill，請先載入。`;

const storyId = z.string().describe('故事 ID');
// 允許較大的回傳直接進入對話，避免完整劇本被轉存成一般可見的檔案
const LARGE = { 'anthropic/maxResultSizeChars': 200_000 };

function reply(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function fail(err: unknown) {
  let error = err instanceof Error ? err.message : String(err);
  let hint: string | undefined;
  if (err instanceof GmaxError) hint = err.hint;
  if (err instanceof z.ZodError) {
    error = err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；');
    hint = '請修正欄位後重試。';
  }
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error, next_action: hint }) }] };
}

export function createServer(store = new Store()): McpServer {
  const engine = new Engine(store);
  const server = new McpServer({ name: 'gmax', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  server.server.oninitialized = () => {
    engine.host = hostOf(server.server.getClientVersion()?.name);
  };

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    run: (args: z.infer<z.ZodObject<S>>) => unknown,
    extra: { readOnly?: boolean; large?: boolean } = {},
  ) => {
    const config = {
      description,
      inputSchema,
      annotations: { readOnlyHint: !!extra.readOnly, destructiveHint: false, openWorldHint: false },
      _meta: extra.large ? LARGE : undefined,
    };
    const handler = async (args: unknown) => {
      try {
        return reply(run(args as z.infer<z.ZodObject<S>>));
      } catch (err) {
        return fail(err);
      }
    };
    // 工具表是動態產生的，泛型在這裡無法再收斂
    (server.registerTool as (n: string, c: unknown, h: unknown) => unknown).call(server, name, config, handler);
  };

  tool('gmax_preferences_get', '讀取玩家的全域預設設定。', {}, () => engine.preferencesGet(), { readOnly: true });
  tool('gmax_preferences_update', '修改全域預設，只影響之後新開的故事。', { patch: preferencesPatchSchema },
    a => engine.preferencesUpdate(a.patch));

  tool('gmax_story_create', '和玩家談定想玩的內容後，建立新故事。overrides 只影響此故事。',
    { title: z.string().min(1), overrides: preferencesPatchSchema.optional() },
    a => engine.storyCreate(a.title, a.overrides ?? {}));
  tool('gmax_story_list', '列出所有故事。', {}, () => engine.storyList(), { readOnly: true });
  tool('gmax_story_resume', '繼續故事，或在對話被壓縮後復原完整上下文。回傳含暴雷內容。', { story_id: storyId },
    a => engine.storyResume(a.story_id), { readOnly: true, large: true });
  tool('gmax_story_status', '讀取可以告訴玩家的進度、參數與已知事實，不含暴雷內容。', { story_id: storyId },
    a => engine.storyStatus(a.story_id), { readOnly: true });
  tool('gmax_story_settings_update', '修改此故事的設定（文風、參數額度等），不影響全域預設。',
    { story_id: storyId, patch: preferencesPatchSchema },
    a => engine.settingsUpdate(a.story_id, a.patch));

  tool('gmax_script_submit', '提交或重新提交完整劇本，通過結構檢查後回傳審查票證。', { story_id: storyId, script: scriptSchema },
    a => engine.scriptSubmit(a.story_id, a.script));
  tool('gmax_script_patch', '只修改部分劇本，不用重傳全部。set 改單一欄位，upsert 以 ID 取代或新增項目，remove 依 ID 刪除。修改上限到了之後，修改會直接套用，不再送審。',
    { story_id: storyId, patch: scriptPatchSchema },
    a => engine.scriptPatch(a.story_id, a.patch));
  tool('gmax_script_review_status', '查詢劇本審查結果。', { story_id: storyId },
    a => engine.scriptReviewStatus(a.story_id), { readOnly: true });
  tool('gmax_script_read', '查詢目前有效的劇本。section 可為 premise、characters、relationships、facts、acts、beats、threads、endings。',
    { story_id: storyId, section: z.string().optional() },
    a => engine.scriptRead(a.story_id, a.section), { readOnly: true, large: true });
  tool('gmax_story_start', '劇本審查通過後開始故事。', { story_id: storyId, accept_issues: z.boolean().optional().describe('修改上限到了仍有問題時，帶著問題開始') },
    a => engine.storyStart(a.story_id, a.accept_issues), { large: true });

  tool('gmax_turn_begin', '收到玩家的故事行動時呼叫。把玩家宣告的設定列入 player_facts：一律成立且不消耗參數。',
    {
      story_id: storyId,
      player_input: z.string().min(1),
      player_facts: z.array(z.object({
        text: z.string().min(1),
        known_by: z.array(z.string()).optional(),
      })).optional(),
      replace: z.boolean().optional().describe('放棄進行中的回合，改用新的玩家輸入重開'),
    },
    a => engine.turnBegin(a.story_id, a.player_input, a.player_facts, a.replace));
  tool('gmax_draft_submit', '提交本回合草稿與宣告，通過程式檢查後回傳審查票證。AI 自行發想的內容要自己填入 spends。',
    {
      story_id: storyId,
      text: z.string(),
      declaration: declarationSchema,
      conservative: z.boolean().optional().describe('修改次數用完後的保守版'),
    },
    a => engine.draftSubmit(a.story_id, a.text, a.declaration, a.conservative));
  tool('gmax_review_status', '查詢本回合審查結果與退稿原因。', { story_id: storyId },
    a => engine.reviewStatus(a.story_id), { readOnly: true });
  tool('gmax_turn_commit', '審查全部通過後提交回合：正式扣參數、寫入事實，並回傳可輸出給玩家的文字。', { story_id: storyId },
    a => engine.turnCommit(a.story_id));
  tool('gmax_turn_abort', '放棄進行中的回合。', { story_id: storyId }, a => engine.turnAbort(a.story_id));
  tool('gmax_turn_rewind', '回到某回合結束時的狀態，之後的事實與參數消耗都會還原。0 代表開場前。',
    { story_id: storyId, to_turn: z.number().int().min(0) },
    a => engine.turnRewind(a.story_id, a.to_turn));

  tool('gmax_review_packet', '審查子代理專用：用票證領取審查資料。', { story_id: storyId, ticket: z.string() },
    a => engine.reviewPacket(a.ticket, a.story_id), { readOnly: true, large: true });
  tool('gmax_review_submit', '審查子代理專用：提交審查結果。',
    {
      story_id: storyId,
      ticket: z.string(),
      verdict: z.enum(['pass', 'reject']),
      issues: z.array(reviewIssueSchema).optional(),
      notes: z.string().optional().describe('不影響結果的備註，文風意見寫這裡'),
    },
    a => engine.reviewSubmit(a.story_id, { ticket: a.ticket, verdict: a.verdict, issues: a.issues, notes: a.notes }));

  tool('gmax_story_end', '故事到達結局時呼叫。未收束的節點與支線會擋下，除非玩家要提前結束。',
    { story_id: storyId, ending_id: z.string(), force: z.boolean().optional() },
    a => engine.storyEnd(a.story_id, a.ending_id, a.force));
  tool('gmax_story_export', '匯出成 Markdown 檔並回傳路徑。include_script 會包含幕後劇本。',
    { story_id: storyId, include_script: z.boolean().optional(), confirm_spoilers: z.boolean().optional() },
    a => engine.storyExport(a.story_id, a.include_script, a.confirm_spoilers));

  return server;
}
