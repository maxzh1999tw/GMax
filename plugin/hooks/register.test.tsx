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
