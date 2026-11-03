import { expect, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const TOOL = 'mcp__plugin_gmax_gmax__gmax_script_read'

const row = (tool: string, input: unknown, extra: object = {}) => ({
  plugin: 'gmax',
  component: 'ToolUse',
  requestId: 'tu1',
  props: {
    tool_use_id: 'tu1', tool, input,
    isRunning: false, isErrored: false, isInterrupted: false,
    ...extra,
  },
}) as const

test('GMax 工具列不顯示參數，展開時也一樣', async $ => {
  for (const surface of SURFACES) {
    for (const isExpanded of [false, true]) {
      const ui = await $.ui.mount({ ...row(TOOL, { secret: '兇手是陳醫生' }, { isExpanded }), surface })
      const text = await ui.find({ type: 'Text' })
      expect(text?.text).toBe('GMax：翻閱劇本')
      await ui.unmount()
    }
  }
})

test('審查子代理也被遮住，其他工具不受影響', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const agent = await $.ui.mount({ ...row('Agent', { subagent_type: 'gmax:gmax-logic-reviewer', prompt: 'x' }), surface: 'desktop' })
  expect((await agent.find({ type: 'Text' }))?.text).toBe('GMax：審稿中')
  await agent.unmount()

  const other = await $.ui.mount({ ...row('Bash', { command: 'ls' }), surface: 'desktop' })
  expect((await other.find({ type: 'Text' }))?.text).toBe('engine')
  await other.unmount()

  const other2 = await $.ui.mount({ ...row('Agent', { subagent_type: 'Explore' }), surface: 'desktop' })
  expect((await other2.find({ type: 'Text' }))?.text).toBe('engine')
  await other2.unmount()
})

test('GMax 工具結果不顯示內容', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine 洩漏</Text>
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'gmax', component: 'ToolResult', requestId: 'tu1', surface,
      props: { tool_use_id: 'tu1', tool: TOOL, output: '兇手是陳醫生', isErrored: false },
    })
    expect(await ui.find({ type: 'Text', text: /洩漏/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('狀態列只顯示回合數，不顯示參數', async ($, on) => {
  const statuses: unknown[] = []
  on('tool.call', () => ({ result: {}, text: JSON.stringify({ phase: 'idle', status_line: 'GMax 第 2 回合｜反轉 0/3' }) }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined } as never
  })
  await $.tool.call({ tool: TOOL } as never)
  expect(statuses).toEqual(['GMax 第 2 回合'])
})

test('流程中的子代理回報不顯示，玩家自己的輸入照常顯示', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine 原文</Text>
  })
  on('tool.call', () => ({ result: {}, text: JSON.stringify({ phase: 'reviewing', reviewers: [{ ticket: 'a' }] }) }))
  on('ui.status', () => ({ value: undefined }) as never)
  await $.tool.call({ tool: TOOL } as never)

  const row = (requestId: string, text: string, kind: string, extra: object = {}) => ({
    plugin: 'gmax', component: 'UserMessage', surface: 'desktop', requestId,
    props: { text, origin: { kind }, isExpanded: true, ...extra },
  }) as never
  const report = await $.ui.mount(row('u1', '已提交，還有 1 項審查未完成', 'unclassified'))
  expect(await report.find({ type: 'Text' })).toBeUndefined()
  await report.unmount()
  const notice = await $.ui.mount(row('u2', 'Agent finished', 'task-notification', { task: { id: 't', status: 'completed' } }))
  expect(await notice.find({ type: 'Text' })).toBeUndefined()
  await notice.unmount()
  const player = await $.ui.mount(row('u3', '我打開門', 'composer'))
  expect((await player.find({ type: 'Text' }))?.text).toBe('engine 原文')
  await player.unmount()
})

test('Mod 直接呼叫模型完成審查：指定模型與思考程度、錯誤會重試、不開子代理', async ($, on) => {
  const asked: { model: string; effort?: string; prompt: string }[] = []
  const submitted: Record<string, unknown>[] = []
  let spawned = 0
  on('agent.spawn', () => {
    spawned++
    return { model: 'm' }
  })
  on('tool.call', { tool: 'mcp__plugin_gmax_gmax__gmax_review_packet' }, ($, e) => ({
    result: {}, text: `資料 ${(e as unknown as { ticket: string }).ticket}`,
  }))
  on('tool.call', { tool: 'mcp__plugin_gmax_gmax__gmax_review_submit' }, ($, e) => {
    submitted.push(e as never)
    const bad = submitted.length === 1
    return { result: {}, text: bad ? '引用的 ID 不存在' : 'ok', isError: bad ? true : undefined } as never
  })
  on('model.complete', ($, e) => {
    asked.push(e as never)
    const text = asked.length === 1 ? '不是 JSON' : '```json\n{"verdict":"pass","notes":"好"}\n```'
    return { value: { isAnswered: true, text, usage: {} } } as never
  })

  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)

  const reply = await ($.tool.call({
    tool: 'mcp__gmax__gmax_run_reviews',
    story_id: 's1',
    reviewers: [{ ticket: 'T-1', agent: 'gmax-logic-reviewer', model: 'inherit', effort: 'high' }],
  } as never) as Promise<{ text: string }>)

  expect(spawned).toBe(0)
  expect(asked[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', prompt: '資料 T-1' })
  expect(asked[1]!.prompt).toContain('不是有效的 JSON')
  expect(asked[2]!.prompt).toContain('引用的 ID 不存在')
  expect(submitted[1]).toMatchObject({ story_id: 's1', ticket: 'T-1', verdict: 'pass', notes: '好' })
  expect(reply.text).toContain('審查都已完成')
})

test('主對話的模型是上限：用 Haiku 開場時全部降成 Haiku', async ($, on) => {
  const asked: string[] = []
  on('session.model', () => ({ value: 'claude-haiku-5-5' }) as never)
  on('tool.call', { tool: 'mcp__plugin_gmax_gmax__gmax_review_packet' }, () => ({ result: {}, text: '資料' }))
  on('tool.call', { tool: 'mcp__plugin_gmax_gmax__gmax_review_submit' }, () => ({ result: {}, text: 'ok' }))
  on('model.complete', ($, e) => {
    asked.push((e as { model: string }).model)
    return { value: { isAnswered: true, text: '{"verdict":"pass"}', usage: {} } } as never
  })
  await $.tool.call({
    tool: 'mcp__gmax__gmax_run_reviews',
    story_id: 's1',
    reviewers: [
      { ticket: 'T-1', agent: 'gmax-logic-reviewer', model: 'inherit' },
      { ticket: 'T-2', agent: 'gmax-ledger-reviewer', model: 'sonnet' },
      { ticket: 'T-3', agent: 'gmax-registry-reviewer', model: 'haiku' },
    ],
  } as never)
  expect(asked.sort()).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5', 'haiku'])
})

test('模型一直失敗時回報未完成，不會卡住', async ($, on) => {
  on('tool.call', { tool: 'mcp__plugin_gmax_gmax__gmax_review_packet' }, () => ({ result: {}, text: '資料' }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } }) as never)
  const reply = await ($.tool.call({
    tool: 'mcp__gmax__gmax_run_reviews',
    story_id: 's1',
    reviewers: [{ ticket: 'T-1', agent: 'gmax-logic-reviewer', model: 'opus' }],
  } as never) as Promise<{ text: string }>)
  expect(reply.text).toContain('1 項審查沒有完成')
})

test('審查還在跑時不提醒，全部回報後才提醒', async ($, on) => {
  let reply = {}
  on('tool.call', () => ({ result: {}, text: JSON.stringify(reply) }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  const appended: unknown[] = []
  on('session.append', ($, e, next) => {
    appended.push(e.message)
    return next(e)
  })
  const complete = () => $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, turnId: 't' } as never)

  reply = { phase: 'reviewing', reviewers: [{ ticket: 'a' }, { ticket: 'b' }] }
  await $.tool.call({ tool: TOOL } as never)
  await complete()
  expect(appended).toHaveLength(0)

  reply = { recorded: 'logic', remaining: 0 }
  await $.tool.call({ tool: TOOL, agentId: 'sub' } as never)
  await complete()
  expect(appended).toHaveLength(1)
})

test('流程進行中的文字被遮住，回合結束後最後一段會顯示', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine 原文</Text>
  })
  on('tool.call', () => ({ result: {}, text: JSON.stringify({ phase: 'writing', status_line: 'GMax 第 1 回合' }) }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  const appended: unknown[] = []
  on('session.append', ($, e, next) => {
    appended.push(e.message)
    return next(e)
  })

  const message = { plugin: 'gmax', component: 'AssistantMessage', surface: 'desktop', props: { text: '原文', isFirstOfReply: true } } as const

  const before = await $.ui.mount({ ...message, requestId: 'm0' })
  expect((await before.find({ type: 'Text' }))?.text).toBe('engine 原文')
  await before.unmount()

  await $.tool.call({ tool: TOOL } as never)

  const middle = await $.ui.mount({ ...message, requestId: 'm1' })
  expect(await middle.find({ type: 'Text' })).toBeUndefined()
  await middle.unmount()

  const waiting = await $.ui.mount({ ...message, requestId: 'm2', props: { text: '主持人構思中…', isFirstOfReply: true } })
  expect(await waiting.find({ type: 'Text' })).toBeUndefined()
  await waiting.unmount()

  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, turnId: 't' } as never)

  const after = await $.ui.mount({ ...message, requestId: 'm1' })
  expect((await after.find({ type: 'Text' }))?.text).toBe('engine 原文')
  await after.unmount()
})
