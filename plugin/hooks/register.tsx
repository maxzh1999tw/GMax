import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const GMAX_TOOL = /^mcp__.*gmax.*__gmax_([a-z_]+)$/
const GMAX_AGENT = /gmax-[a-z]+-reviewer$/

const LABELS: Record<string, string> = {
  preferences_get: '讀取玩家設定',
  preferences_update: '更新玩家設定',
  story_create: '建立故事',
  story_list: '查詢故事列表',
  story_resume: '回顧故事',
  story_status: '查詢進度',
  story_settings_update: '更新故事設定',
  script_submit: '撰寫劇本',
  script_review_status: '確認劇本審查',
  script_read: '翻閱劇本',
  story_start: '開始故事',
  turn_begin: '構思下一段',
  draft_submit: '提交草稿',
  review_status: '確認審稿結果',
  turn_commit: '定稿',
  turn_abort: '放棄本回合',
  turn_rewind: '回到先前的回合',
  review_packet: '領取審查資料',
  review_submit: '提交審查',
  story_end: '結束故事',
  story_export: '匯出故事',
}

const ACTIVE_PHASES = ['authoring', 'writing', 'reviewing']
const UNFINISHED_PHASES = ['writing', 'reviewing']
const WAITING_TEXT = /^\s*(GMax：)?主持人(構思|思考)中/
const FLOW_TEXT = /^\s*\[GMax 提醒\]|已提交(，還有 \d+ 項審查未完成|，本輪審查全部完成)/

const revealed = atom({ plugin: 'gmax', key: 'revealed' } as const, [] as string[])

function gmaxLabel(tool: string, input: unknown): string | undefined {
  const name = GMAX_TOOL.exec(tool)?.[1]
  if (name) return `GMax：${LABELS[name] ?? '處理中'}`
  if (tool === 'Agent' || tool === 'Task') {
    const type = (input as { subagent_type?: unknown } | null)?.subagent_type
    if (typeof type === 'string' && GMAX_AGENT.test(type)) return 'GMax：審稿中'
  }
  return undefined
}

type Reply = {
  phase?: string
  status_line?: string
  reviewers?: unknown[]
  pending?: unknown[]
  remaining?: number
}

function parseReply(text: string | undefined): Reply {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export const register: Register = on => {
  let phase = 'idle'
  let reviewsRunning = 0
  let lastMasked: string | undefined
  const decided = new Map<string, boolean>()
  const hiddenRows = new Map<string, boolean>()

  // 權限對話框會顯示完整的工具參數（包含草稿與劇本），所以只放行 GMax 自己的工具
  on('classic.PermissionRequest', ($, e, next) =>
    GMAX_TOOL.test(e.tool_name) ? { decision: { behavior: 'allow' } } : next(e),
  ).catch((($, e, next) => next(e)))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!GMAX_TOOL.test(String(e.tool))) return ran
    const reply = parseReply(ran.text)
    if (e.agentId !== undefined) {
      if (typeof reply.remaining === 'number') reviewsRunning = reply.remaining
      return ran
    }
    if (reply.phase) phase = reply.phase
    if (reply.reviewers) reviewsRunning = reply.reviewers.length
    else if (reply.pending) reviewsRunning = reply.pending.length
    // 只顯示回合數：參數消耗會讓玩家猜出哪段是誤導或反轉
    if (reply.status_line) $.ui.status(reply.status_line.split('｜')[0])
    return ran
  }).catch((($, e, next) => next(e)))

  // 工具列只改畫面，模型讀到的內容與儲存的結果都不受影響；ctrl+o 也同樣遮住
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    const label = gmaxLabel(e.props.tool, e.props.input)
    if (!label) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.isRunning ? `${label}…` : label}</Text>
  })

  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (!GMAX_TOOL.test(e.props.tool)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // 流程進行中的文字可能帶到劇情，先遮住；每回合的最後一段是給玩家的話，一律顯示
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const { Box } = $.ui.resolve(e)
    if (WAITING_TEXT.test(e.props.text)) return <Box />
    if ((await read($, revealed)).includes(e.requestId)) return next(e)
    let masked = decided.get(e.requestId)
    if (masked === undefined) {
      masked = ACTIVE_PHASES.includes(phase)
      decided.set(e.requestId, masked)
    }
    if (!masked) return next(e)
    lastMasked = e.requestId
    return <Box />
  })

  // 子代理的回報與背景工作通知只是流程雜訊，玩家不用看到
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const flowRow = (e.props.task !== undefined || e.props.from !== undefined) && ACTIVE_PHASES.includes(phase)
    let hidden = hiddenRows.get(e.requestId)
    if (hidden === undefined) {
      hidden = FLOW_TEXT.test(e.props.text) || flowRow
      hiddenRows.set(e.requestId, hidden)
    }
    if (!hidden) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // 審查還在跑時，這一輪的文字只是等待，不算給玩家的話
    if (lastMasked && reviewsRunning === 0) {
      const id = lastMasked
      lastMasked = undefined
      await update($, revealed, ids => [...(ids ?? []), id])
    }
    // 審查還在跑時結束這一輪是正常的等待，不用提醒
    if (e.reason === 'answer' && UNFINISHED_PHASES.includes(phase) && reviewsRunning === 0) {
      $.ui.toast('GMax：本回合還沒走完審稿流程')
      await $.session.append({
        message: {
          type: 'user',
          content: [{
            type: 'text',
            text: '[GMax 提醒] 上一輪結束時，故事回合尚未提交。如果那段回覆包含故事內容，它沒有經過審稿；下次先用 gmax_review_status 接續或放棄該回合。',
          }],
        },
      })
    }
    return next(e)
  })

  on('session.end', ($, e, next) => {
    phase = 'idle'
    return next(e)
  })
}
