/**
 * REQ 主状态机 + 迁移守卫。
 *
 * 状态与迁移都来自流程图；图中缺失的终态/异常态在这里补全：
 *  - cancelled：v1 不支持需求变更，仅允许提前取消；
 *  - blocked：轮次耗尽 / 超出 Leader 能力时挂起，等待用户判断（escalation_resolve 恢复）。
 *
 * 守卫只回答“这个迁移现在允许吗”，不改变数据；轮次耗尽由 tools 层在动作发生前判定。
 */

/** REQ 主状态。 */
export const REQ_STATES = Object.freeze([
  'draft',          // 已受理
  'designing',      // 双设计进行中
  'design_review',  // 限轮互评
  'design_fixed',   // DA 仲裁定稿
  'coding',         // 编码 + worktree 隔离
  'code_review',    // 审码
  'instrumenting',  // 埋点（调试期详日志）
  'acceptance',     // 操作验收
  'debugging',      // 调试定位
  'fixing',         // 修复 + 复核
  'normalizing',    // 日志规范化
  'blocked',        // 等待用户判断
  'closed',         // 关闭
  'cancelled',      // 取消（v1 无需求变更）
])

/** 图里显式存在 + 必须补的迁移。 */
export const TRANSITIONS = Object.freeze({
  draft: ['designing', 'cancelled'],
  designing: ['design_review', 'cancelled'],
  design_review: ['design_fixed', 'cancelled'],
  design_fixed: ['coding', 'cancelled'],
  coding: ['code_review', 'cancelled'],
  code_review: ['coding', 'instrumenting', 'cancelled'],
  instrumenting: ['acceptance', 'cancelled'],
  acceptance: ['normalizing', 'debugging', 'cancelled'],
  debugging: ['instrumenting', 'fixing', 'cancelled'],
  fixing: ['acceptance', 'code_review', 'cancelled'],
  normalizing: ['closed', 'cancelled'],
  blocked: [],
  closed: [],
  cancelled: [],
})

/** 终态。 */
export const TERMINAL_STATES = Object.freeze(['closed', 'cancelled'])

/**
 * @param {string} state
 */
export function isTerminal(state) {
  return TERMINAL_STATES.includes(state)
}

/**
 * @param {string} state
 */
export function nextStates(state) {
  return TRANSITIONS[state] ?? []
}

/**
 * 迁移守卫：返回 null 表示允许，否则返回人话原因。
 * @param {object} req REQ 记录（criteria 内联；tasks/issues 可能是 ID，需传 db 解析）
 * @param {string} to 目标状态
 * @param {object} cfg 归一化配置
 * @param {{tasks?: object, issues?: object}} [db] 用于把 tasks/issues 的 ID 解析成记录
 */
export function guardTransition(req, to, cfg, db) {
  const resolve = (list, table) => (list ?? [])
    .map(entry => (typeof entry === 'string' ? table?.[entry] : entry))
    .filter(Boolean)
  const tasks = resolve(req.tasks, db?.tasks)
  const issues = resolve(req.issues, db?.issues)
  const publicCriteria = (req.criteria ?? []).filter(c => c.layer === 'public')
  const openIssue = issues.filter(i => i.status !== 'closed')
  const submittedTasks = tasks.filter(t => t.submitted)

  switch (to) {
    case 'design_review':
      if (!req.design?.submissions?.A || !req.design?.submissions?.B) {
        return '进入互评前需要两个设计 WorkAgent 都已提交方案（design_submit A/B）'
      }
      return null
    case 'design_fixed':
      if (!req.design?.arbitration) return '进入定稿前需要 design_arbitrate 记录仲裁结论'
      return null
    case 'coding':
      if (publicCriteria.length === 0) {
        return '进入编码前必须至少有一条 public 验收项（criteria_add layer=public）'
      }
      return null
    case 'code_review':
      if (!req.ci) return '进入审码前需要 ci_gate 记录一次 CI 结果'
      if (req.ci.passed !== true) return 'CI 未通过，不能进入审码'
      if (submittedTasks.length === 0) return '没有任何已提交的编码任务（task_submit）'
      return null
    case 'instrumenting':
      if (openIssue.length > 0) return `仍有 ${openIssue.length} 个未关闭 Issue，不能进入埋点`
      return null
    case 'acceptance':
      if (!req.logging?.delivered) return '进入操作验收前需要埋点团队交付日志与调试信息（log_deliver）'
      return null
    case 'normalizing':
      if (req.acceptance?.verdict !== 'pass') return '操作验收未通过，不能进入日志规范化'
      return null
    case 'debugging':
      if (req.acceptance?.verdict !== 'fail') return '只有操作验收失败才进入调试分支'
      if ((req.tickets ?? []).length === 0) return '进入调试前需要把用户反馈转成结构化支持工单（support_ticket）'
      return null
    case 'fixing':
      if (!issues.some(i => i.severity === 'severe' && i.status !== 'closed')) {
        return '进入修复前，调试团队需要提交严重 Issue（issue_open severity=severe）'
      }
      return null
    case 'instrumenting_from_debug':
      return null
    case 'closed':
      if (cfg.reserved.enabled) {
        const pending = (req.criteria ?? []).filter(c => !c.verified?.passed)
        if (pending.length > 0) return `仍有 ${pending.length} 条验收项未通过（含保留层），不能关闭`
      } else {
        const pendingPublic = publicCriteria.filter(c => !c.verified?.passed)
        if (pendingPublic.length > 0) return `仍有 ${pendingPublic.length} 条公开验收项未通过，不能关闭`
      }
      if (!req.logging?.normalized) return '关闭前需要日志规范化完成（log_normalize）'
      return null
    default:
      return null
  }
}

/**
 * 一个动作是否会把某个轮次用超；超限即阻塞上抛，提示调用 dp_escalate。
 * @param {number} used 已用次数
 * @param {number} limit 配置上限
 * @param {string} label 人话名称
 */
export function assertRoundBudget(used, limit, label) {
  if (used >= limit) {
    const error = new Error(
      `轮次已耗尽：${label} 上限 ${limit} 轮，当前已用 ${used} 轮。`
      + '按 v1 协议必须由用户判断：调用 dp_escalate 挂起 REQ 并上报，不要继续循环。',
    )
    error.code = 'ROUND_EXHAUSTED'
    throw error
  }
}
