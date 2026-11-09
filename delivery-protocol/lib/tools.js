/**
 * 模型面工具集：全部以 dp_ 前缀注册，避免与其他插件撞名。
 *
 * 设计约束（与用户确认过的 5 条决定一致）：
 *  - 轮次全部来自配置；超限抛 ROUND_EXHAUSTED，必须走 dp_escalate 交用户判断；
 *  - 仲裁：Leader 能力范围内（不改验收标准/不改需求目标/不加预算/不调编制）可自行拍板并记录，
 *    否则 dp_escalate 挂起等待用户；
 *  - v1 不支持需求变更，只有 cancelled 终态；
 *  - 保留层验收：数据不在工作区，且只有根 Agent（Lead）可读写，非根 Agent 只看到脱敏摘要；
 *  - 隔离：每个编码任务一个 git worktree 分支，插件只依赖 git。
 */
import { makeId } from './store.js'
import { assertRoundBudget, guardTransition, nextStates, isTerminal } from './state.js'
import { createWorktree, resolveRepo } from './worktree.js'

const nowIso = () => new Date().toISOString()

/** 文本进渲染。 */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * 声明一个工具：参数用受支持的 JSON Schema 子集，输出统一 object + JSON 文本。
 * 不 import @deepseek-ai/dsh-tools，保持零运行时依赖。
 */
function define(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'object' }, render: renderJson },
    execute,
  }
}

/** 参数对象构造：properties + required + 禁多余字段。 */
function params(properties, required) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}

const S = description => ({ type: 'string', description })
const B = description => ({ type: 'boolean', description })
const A = (description, items) => ({ type: 'array', description, items })
const I = description => ({ type: 'integer', description })

/** 调用方是否根 Agent（Lead）。根 = 不由其他 Agent 创建。 */
function isRootAgent(ctx, agent) {
  if (!agent) return false
  const agents = ctx.get?.('agents')
  if (!agents || typeof agents.roots !== 'function') return false
  try {
    return agents.roots().some(root => root === agent || root?.id === agent.id)
  } catch {
    return false
  }
}

/** 保留层对当前调用方是否可见。 */
function reservedVisible(ctx, agent, cfg) {
  if (!cfg.reserved.enabled) return false
  if (!cfg.reserved.rootOnly) return true
  return isRootAgent(ctx, agent)
}

/**
 * 对外视图：非根 Agent 看不到保留层内容，只看到条数与“存在保留验收”的事实。
 * @param {object} req
 * @param {boolean} withReserved
 */
function view(req, withReserved) {
  const cloned = structuredClone(req)
  const reserved = cloned.criteria.filter(c => c.layer === 'reserved')
  cloned.criteria = cloned.criteria.filter(c => c.layer !== 'reserved')
  if (withReserved) {
    cloned.criteria = structuredClone(req.criteria)
  } else {
    cloned.reserved = {
      enabled: true,
      count: reserved.length,
      redacted: true,
      note: '保留层验收标准归 Leader 与最终验收方持有；执行侧只能看到数量。',
    }
  }
  cloned.allowedNext = nextStates(req.state)
  return cloned
}

function getReq(db, reqId) {
  const req = db.reqs[reqId]
  if (!req) throw new Error(`REQ 不存在：${reqId}`)
  return req
}

function getTask(db, taskId) {
  const task = db.tasks[taskId]
  if (!task) throw new Error(`编码任务不存在：${taskId}`)
  return task
}

function getIssue(db, issueId) {
  const issue = db.issues[issueId]
  if (!issue) throw new Error(`Issue 不存在：${issueId}`)
  return issue
}

function refresh(req) {
  req.updatedAt = nowIso()
}

function newReq(id, title, summary, workspace) {
  return {
    id,
    title,
    summary: summary ?? '',
    state: 'draft',
    workspace: workspace ?? '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    criteria: [],
    design: { submissions: {}, reviews: [], arbitration: null },
    tasks: [],
    issues: [],
    tickets: [],
    decisions: [],
    ci: null,
    acceptance: null,
    logging: { delivered: false, normalized: false },
    counters: { mutualReview: 0, battle: 0, fixLoop: 0, logRequest: 0, acceptanceFail: 0, rejectAdjudicate: 0 },
    history: [],
  }
}

/**
 * @param {object} context
 * @param {import('cordis').Context} context.ctx
 * @param {object} context.cfg 归一化配置
 * @param {object} context.store
 */
export function createTools({ ctx, cfg, store }) {
  /** 收集审计事件，随写事务一起落 events.jsonl。 */
  const tool = (name, description, parameters, execute) => define(name, description, parameters, execute)

  const tools = []

  tools.push(tool('dp_req_open',
    '受理一个需求并创建 REQ-ID。之后所有阶段动作都挂在 REQ 上。',
    params({
      title: S('需求标题'),
      summary: S('需求摘要（可选）'),
      workspace: S('仓库根路径（可选，编码阶段 worktree 默认用这里）'),
    }, ['title']),
    async (args, exec) => {
      const events = []
      const result = await store.write((db) => {
        const id = makeId(db, 'REQ')
        const req = newReq(id, args.title, args.summary, args.workspace)
        db.reqs[id] = req
        events.push({ type: 'req.open', reqId: id, actor: agentId(exec), title: args.title })
        return { reqId: id, state: req.state }
      }, events)
      return result
    }))

  tools.push(tool('dp_req_get',
    '读取一个 REQ 的完整状态。非根 Agent 看不到保留层验收内容（只看到数量与脱敏提示）。',
    params({ reqId: S('REQ-ID') }, ['reqId']),
    async (args, exec) => {
      return store.read((db) => {
        const req = getReq(db, args.reqId)
        return view(req, reservedVisible(ctx, exec.agent, cfg))
      })
    }))

  tools.push(tool('dp_req_list',
    '列出 REQ（可按状态过滤）。',
    params({ state: S('状态过滤（可选）') }, []),
    async (args) => {
      const items = await store.read((db) => Object.values(db.reqs)
        .filter(req => args.state === undefined || req.state === args.state)
        .map(req => ({ reqId: req.id, title: req.title, state: req.state, updatedAt: req.updatedAt })))
      return { items }
    }))

  tools.push(tool('dp_req_transition',
    '推进 REQ 状态机。前置条件不满足会被拒绝；轮次耗尽必须先 dp_escalate。',
    params({
      reqId: S('REQ-ID'),
      to: S('目标状态'),
      note: S('迁移说明（可选）'),
    }, ['reqId', 'to']),
    async (args, exec) => {
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        return transition(db, req, args.to, { exec, cfg, events, note: args.note })
      }, events)
    }))

  tools.push(tool('dp_req_cancel',
    '取消 REQ（v1 不支持需求变更，这是唯一提前终态）。仅 Leader 可调用。',
    params({ reqId: S('REQ-ID'), reason: S('取消原因') }, ['reqId', 'reason']),
    async (args, exec) => {
      if (!isRootAgent(ctx, exec.agent)) throw new Error('只有 Leader（根 Agent）可以取消 REQ')
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        if (isTerminal(req.state)) throw new Error(`REQ 已是终态：${req.state}`)
        const from = req.state
        req.state = 'cancelled'
        req.cancelReason = args.reason
        req.history.push({ from, to: 'cancelled', at: nowIso(), note: args.reason })
        refresh(req)
        events.push({ type: 'req.cancel', reqId: req.id, actor: agentId(exec), reason: args.reason })
        return { reqId: req.id, state: req.state }
      }, events)
    }))

  tools.push(tool('dp_criteria_add',
    '添加验收项。layer=public 对执行侧可见；layer=reserved 仅 Leader 可见（保留层）。',
    params({
      reqId: S('REQ-ID'),
      layer: S('public 或 reserved'),
      text: S('验收项描述'),
      check: S('判定方式（可选）'),
    }, ['reqId', 'layer', 'text']),
    async (args, exec) => {
      if (args.layer !== 'public' && args.layer !== 'reserved') throw new Error('layer 必须是 public 或 reserved')
      if (args.layer === 'reserved') {
        if (!cfg.reserved.enabled) throw new Error('保留层验收未启用（config.reserved.enabled=false）')
        if (!isRootAgent(ctx, exec.agent)) throw new Error('保留层验收项只有 Leader（根 Agent）可以写入')
      }
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        if (isTerminal(req.state)) throw new Error(`REQ 已是终态：${req.state}`)
        if (args.layer === 'public' && ['coding', 'code_review', 'instrumenting', 'acceptance', 'debugging', 'fixing', 'normalizing'].includes(req.state)) {
          throw new Error('公开验收项在进入编码阶段后冻结，不能再添加')
        }
        const id = makeId(db, 'CRIT')
        req.criteria.push({ id, layer: args.layer, text: args.text, check: args.check ?? '', verified: { passed: false } })
        refresh(req)
        events.push({ type: 'criteria.add', reqId: req.id, criterionId: id, layer: args.layer, actor: agentId(exec) })
        return { criterionId: id, layer: args.layer, publicCount: req.criteria.filter(c => c.layer === 'public').length }
      }, events)
    }))

  tools.push(tool('dp_criteria_list',
    '列出验收项。非根 Agent 只会拿到 public 层。',
    params({ reqId: S('REQ-ID'), layer: S('public 或 reserved（可选）') }, ['reqId']),
    async (args, exec) => {
      const items = await store.read((db) => {
        const req = getReq(db, args.reqId)
        const visible = reservedVisible(ctx, exec.agent, cfg)
        return req.criteria
          .filter(c => args.layer === undefined || c.layer === args.layer)
          .filter(c => visible || c.layer === 'public')
          .map(c => ({ ...c }))
      })
      return { items }
    }))

  tools.push(tool('dp_criteria_verify',
    '记录一条验收项的判定结果。保留层验收只能由 Leader 执行。',
    params({
      reqId: S('REQ-ID'),
      criterionId: S('验收项 ID'),
      passed: B('是否通过'),
      evidence: S('证据（日志/测试/复现步骤）'),
    }, ['reqId', 'criterionId', 'passed', 'evidence']),
    async (args, exec) => {
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        const criterion = req.criteria.find(c => c.id === args.criterionId)
        if (!criterion) throw new Error(`验收项不存在：${args.criterionId}`)
        if (criterion.layer === 'reserved' && !isRootAgent(ctx, exec.agent)) {
          throw new Error('保留层验收项只有 Leader（根 Agent）可以判定')
        }
        criterion.verified = { passed: args.passed === true, evidence: args.evidence, at: nowIso(), by: agentId(exec) }
        refresh(req)
        events.push({ type: 'criteria.verify', reqId: req.id, criterionId: criterion.id, passed: criterion.verified.passed, actor: agentId(exec) })
        return { criterionId: criterion.id, passed: criterion.verified.passed }
      }, events)
    }))

  tools.push(tool('dp_design_submit',
    '提交设计阶段方案（双 WorkAgent 独立设计，slot 固定 A/B）。',
    params({ reqId: S('REQ-ID'), slot: S('A 或 B'), content: S('设计内容（Markdown）') }, ['reqId', 'slot', 'content']),
    async (args, exec) => {
      if (args.slot !== 'A' && args.slot !== 'B') throw new Error('slot 必须是 A 或 B')
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        if (req.state !== 'designing') throw new Error(`当前状态 ${req.state} 不接受设计提交，需先进入 designing`)
        req.design.submissions[args.slot] = { content: args.content, at: nowIso(), by: agentId(exec) }
        refresh(req)
        events.push({ type: 'design.submit', reqId: req.id, slot: args.slot, actor: agentId(exec) })
        return { slot: args.slot, bothReady: Boolean(req.design.submissions.A && req.design.submissions.B) }
      }, events)
    }))

  tools.push(tool('dp_design_review',
    '设计互评：主张/证据/反例/建议。轮次受 config.rounds.mutualReview 限制。',
    params({
      reqId: S('REQ-ID'),
      reviewer: S('A 或 B'),
      target: S('被评论的 slot（A 或 B）'),
      claims: S('主张'),
      evidence: S('证据'),
      counterexamples: S('反例'),
      suggestions: S('建议'),
    }, ['reqId', 'reviewer', 'target', 'claims', 'evidence']),
    async (args, exec) => {
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        if (req.state !== 'design_review') throw new Error(`当前状态 ${req.state} 不接受互评，需先进入 design_review`)
        const round = req.counters.mutualReview
        const thisRound = req.design.reviews.filter(r => r.round === round)
        assertRoundBudget(round, cfg.rounds.mutualReview, '设计互评')
        if (thisRound.some(r => r.reviewer === args.reviewer)) throw new Error(`本轮 ${args.reviewer} 已提交过互评`)
        req.design.reviews.push({
          round,
          reviewer: args.reviewer,
          target: args.target,
          claims: args.claims,
          evidence: args.evidence,
          counterexamples: args.counterexamples ?? '',
          suggestions: args.suggestions ?? '',
          at: nowIso(),
          by: agentId(exec),
        })
        if (req.design.reviews.filter(r => r.round === round).length >= 2) req.counters.mutualReview += 1
        refresh(req)
        events.push({ type: 'design.review', reqId: req.id, round, reviewer: args.reviewer, actor: agentId(exec) })
        return { round, roundsUsed: req.counters.mutualReview, roundLimit: cfg.rounds.mutualReview }
      }, events)
    }))

  tools.push(tool('dp_design_arbitrate',
    'DA 仲裁：采纳 A / B / 融合，写 ADR 摘要。完成后自动进入 design_fixed。',
    params({
      reqId: S('REQ-ID'),
      decision: S('A、B 或 merge'),
      rationale: S('裁决依据'),
      dissent: S('保留意见（可选）'),
    }, ['reqId', 'decision', 'rationale']),
    async (args, exec) => {
      if (!['A', 'B', 'merge'].includes(args.decision)) throw new Error('decision 必须是 A、B 或 merge')
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        if (req.state !== 'design_review') throw new Error(`当前状态 ${req.state} 不接受仲裁，需先处于 design_review`)
        req.design.arbitration = {
          decision: args.decision,
          rationale: args.rationale,
          dissent: args.dissent ?? '',
          at: nowIso(),
          by: agentId(exec),
        }
        const from = req.state
        req.state = 'design_fixed'
        req.history.push({ from, to: 'design_fixed', at: nowIso(), note: `仲裁：${args.decision}` })
        refresh(req)
        events.push({ type: 'design.arbitrate', reqId: req.id, decision: args.decision, actor: agentId(exec) })
        return { reqId: req.id, state: req.state, decision: args.decision }
      }, events)
    }))

  tools.push(tool('dp_task_create',
    '按依赖图拆分一个编码任务，声明模块与文件边界。',
    params({
      reqId: S('REQ-ID'),
      module: S('模块名'),
      files: A('允许修改的文件/目录（相对仓库根）', S('路径')),
      dependsOn: A('依赖的任务 ID（可选）', S('任务 ID')),
    }, ['reqId', 'module', 'files']),
    async (args) => {
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        if (!['design_fixed', 'coding'].includes(req.state)) throw new Error(`当前状态 ${req.state} 不接受任务拆分`)
        for (const dep of args.dependsOn ?? []) {
          if (!db.tasks[dep]) throw new Error(`依赖的任务不存在：${dep}`)
        }
        const id = makeId(db, 'TASK')
        db.tasks[id] = {
          id,
          reqId: req.id,
          module: args.module,
          files: args.files,
          dependsOn: args.dependsOn ?? [],
          status: 'created',
          worktree: null,
          submitted: false,
          createdAt: nowIso(),
        }
        req.tasks.push(id)
        refresh(req)
        events.push({ type: 'task.create', reqId: req.id, taskId: id, module: args.module })
        return { taskId: id, module: args.module }
      }, events)
    }))

  tools.push(tool('dp_worktree_create',
    '为编码任务创建独立 git worktree 分支（隔离修改）。',
    params({
      taskId: S('任务 ID'),
      repoRoot: S('仓库根（可选，默认用 REQ.workspace 或进程 cwd）'),
    }, ['taskId']),
    async (args, exec) => {
      const events = []
      return store.write(async (db) => {
        const task = getTask(db, args.taskId)
        if (task.worktree) return { taskId: task.id, ...task.worktree, reused: true }
        const req = getReq(db, task.reqId)
        const repoRoot = args.repoRoot || cfg.worktree.repoRoot || req.workspace || process.cwd()
        const branch = `dp/${task.id}`
        const created = await createWorktree({
          repoRoot,
          branch,
          dir: cfg.worktree.dir,
          baseRef: cfg.worktree.baseRef,
          signal: exec.signal,
        })
        task.worktree = created
        task.status = 'worktree-ready'
        refresh(req)
        events.push({ type: 'task.worktree', reqId: req.id, taskId: task.id, branch, path: created.path })
        return { taskId: task.id, ...created }
      }, events)
    }))

  tools.push(tool('dp_task_submit',
    '编码子 Agent 提交代码：记录变更说明与自检结果。',
    params({
      taskId: S('任务 ID'),
      summary: S('变更说明'),
      tests: S('自检/单测结果（可选）'),
      commit: S('提交 SHA（可选）'),
    }, ['taskId', 'summary']),
    async (args) => {
      const events = []
      return store.write((db) => {
        const task = getTask(db, args.taskId)
        task.submitted = true
        task.submittedAt = nowIso()
        task.status = 'submitted'
        task.summary = args.summary
        task.tests = args.tests ?? ''
        task.commit = args.commit ?? ''
        const req = getReq(db, task.reqId)
        refresh(req)
        events.push({ type: 'task.submit', reqId: req.id, taskId: task.id, commit: task.commit })
        return { taskId: task.id, submitted: true }
      }, events)
    }))

  tools.push(tool('dp_ci_gate',
    '记录 CI 门禁结果（编译/单测/静态检查/关键路径冒烟）。通过后才能进入审码。',
    params({ reqId: S('REQ-ID'), passed: B('是否通过'), details: S('检查明细') }, ['reqId', 'passed', 'details']),
    async (args, exec) => {
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        if (isTerminal(req.state)) throw new Error(`REQ 已是终态：${req.state}`)
        req.ci = { passed: args.passed === true, details: args.details, at: nowIso(), by: agentId(exec) }
        refresh(req)
        events.push({ type: 'ci.gate', reqId: req.id, passed: req.ci.passed })
        return { reqId: req.id, ciPassed: req.ci.passed, allowedNext: nextStates(req.state) }
      }, events)
    }))

  tools.push(tool('dp_issue_open',
    '审码/调试团队登记 Issue。severity=severe 走升级通道且不允许被拒。',
    params({
      reqId: S('REQ-ID'),
      severity: S('normal 或 severe'),
      module: S('模块'),
      file: S('文件（可选）'),
      line: S('行号说明（可选）'),
      title: S('Issue 标题'),
      description: S('问题描述'),
      evidence: S('证据（复现/日志/截图说明）'),
    }, ['reqId', 'severity', 'module', 'title', 'description', 'evidence']),
    async (args, exec) => {
      if (args.severity !== 'normal' && args.severity !== 'severe') throw new Error('severity 必须是 normal 或 severe')
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        if (isTerminal(req.state)) throw new Error(`REQ 已是终态：${req.state}`)
        const id = makeId(db, 'ISS')
        db.issues[id] = {
          id,
          reqId: req.id,
          severity: args.severity,
          module: args.module,
          file: args.file ?? '',
          line: args.line ?? '',
          title: args.title,
          description: args.description,
          evidence: args.evidence,
          status: 'open',
          responses: [],
          battles: [],
          createdAt: nowIso(),
        }
        req.issues.push(id)
        refresh(req)
        events.push({ type: 'issue.open', reqId: req.id, issueId: id, severity: args.severity, actor: agentId(exec) })
        return { issueId: id, severity: args.severity, status: 'open' }
      }, events)
    }))

  tools.push(tool('dp_issue_respond',
    '编码方响应 Issue：accept / reject（结构化理由）/ request-evidence（严重 Issue 专用）。',
    params({
      issueId: S('Issue ID'),
      action: S('accept、reject 或 request-evidence'),
      basis: S('拒绝依据（reject 必填）'),
      evidence: S('反证（reject 必填）'),
      alternative: S('替代方案（reject 必填）'),
      risk: S('剩余风险（reject 必填）'),
    }, ['issueId', 'action']),
    async (args, exec) => {
      const allowReject = ['open', 'assigned', 'reopen']
      const events = []
      return store.write((db) => {
        const issue = getIssue(db, args.issueId)
        const req = getReq(db, issue.reqId)
        if (!allowReject.includes(issue.status)) throw new Error(`Issue 当前状态 ${issue.status} 不能响应`)
        if (args.action === 'accept') {
          issue.status = 'accepted'
        } else if (args.action === 'request-evidence') {
          if (issue.severity !== 'severe') throw new Error('request-evidence 只用于严重 Issue')
          issue.status = 'evidence-requested'
          issue.evidenceRequest = { by: agentId(exec), at: nowIso() }
        } else if (args.action === 'reject') {
          if (issue.severity === 'severe') throw new Error('严重 Issue 不允许拒绝，只能 request-evidence 要求补充证据')
          const missing = ['basis', 'evidence', 'alternative', 'risk'].filter(key => !args[key])
          if (missing.length > 0) throw new Error(`拒绝必须给结构化理由，缺少：${missing.join(', ')}`)
          const rejected = issue.responses.filter(r => r.action === 'reject').length
          assertRoundBudget(rejected, cfg.rounds.rejectAdjudicate, '普通 Issue 拒绝裁决')
          issue.status = 'rejected'
          issue.responses.push({ action: 'reject', basis: args.basis, evidence: args.evidence, alternative: args.alternative, risk: args.risk, at: nowIso(), by: agentId(exec) })
        } else {
          throw new Error('action 必须是 accept、reject 或 request-evidence')
        }
        refresh(req)
        events.push({ type: 'issue.respond', reqId: req.id, issueId: issue.id, action: args.action, actor: agentId(exec) })
        return { issueId: issue.id, status: issue.status }
      }, events)
    }))

  tools.push(tool('dp_issue_adjudicate',
    'CA/Leader 裁决拒绝是否合理：reject-valid（关闭）或 must-fix（打回修复）。仅 Leader 可调用。',
    params({ issueId: S('Issue ID'), verdict: S('reject-valid 或 must-fix'), rationale: S('裁决依据') }, ['issueId', 'verdict', 'rationale']),
    async (args, exec) => {
      if (!isRootAgent(ctx, exec.agent)) throw new Error('Issue 拒绝裁决只有 Leader（根 Agent）可以执行')
      if (args.verdict !== 'reject-valid' && args.verdict !== 'must-fix') throw new Error('verdict 必须是 reject-valid 或 must-fix')
      const events = []
      return store.write((db) => {
        const issue = getIssue(db, args.issueId)
        const req = getReq(db, issue.reqId)
        issue.adjudication = { verdict: args.verdict, rationale: args.rationale, at: nowIso(), by: agentId(exec) }
        issue.status = args.verdict === 'reject-valid' ? 'closed' : 'open'
        refresh(req)
        events.push({ type: 'issue.adjudicate', reqId: req.id, issueId: issue.id, verdict: args.verdict })
        return { issueId: issue.id, status: issue.status }
      }, events)
    }))

  tools.push(tool('dp_issue_close',
    '关闭已修复并复核通过的 Issue。',
    params({ issueId: S('Issue ID'), evidence: S('复核证据') }, ['issueId', 'evidence']),
    async (args, exec) => {
      const events = []
      return store.write((db) => {
        const issue = getIssue(db, args.issueId)
        const req = getReq(db, issue.reqId)
        issue.status = 'closed'
        issue.closeEvidence = args.evidence
        refresh(req)
        events.push({ type: 'issue.close', reqId: req.id, issueId: issue.id, actor: agentId(exec) })
        return { issueId: issue.id, status: 'closed' }
      }, events)
    }))

  tools.push(tool('dp_battle_record',
    '记录审码方与编码方的 1v1 Battle 回合（主张/证据/反例/建议/结论）。',
    params({
      issueId: S('Issue ID'),
      side: S('review 或 code'),
      claims: S('主张'),
      evidence: S('证据'),
      counterexamples: S('反例'),
      suggestions: S('建议'),
      conclusion: S('本轮结论（可选）'),
    }, ['issueId', 'side', 'claims', 'evidence']),
    async (args, exec) => {
      if (args.side !== 'review' && args.side !== 'code') throw new Error('side 必须是 review 或 code')
      const events = []
      return store.write((db) => {
        const issue = getIssue(db, args.issueId)
        const req = getReq(db, issue.reqId)
        assertRoundBudget(issue.battles.length, cfg.rounds.battle, '1v1 Battle')
        issue.battles.push({
          side: args.side,
          claims: args.claims,
          evidence: args.evidence,
          counterexamples: args.counterexamples ?? '',
          suggestions: args.suggestions ?? '',
          conclusion: args.conclusion ?? '',
          at: nowIso(),
          by: agentId(exec),
        })
        refresh(req)
        events.push({ type: 'issue.battle', reqId: req.id, issueId: issue.id, side: args.side })
        return { issueId: issue.id, battleRounds: issue.battles.length, limit: cfg.rounds.battle }
      }, events)
    }))

  tools.push(tool('dp_decision_record',
    '记录一次仲裁/裁决（Leader 能力范围内的决定），形成可审计的决定记录。',
    params({
      reqId: S('REQ-ID'),
      kind: S('决定类型（如 round-exhausted、reject-adjudicate、design-arbitrate）'),
      decision: S('结论'),
      rationale: S('依据'),
      dissent: S('保留意见（可选）'),
    }, ['reqId', 'kind', 'decision', 'rationale']),
    async (args, exec) => {
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        const id = makeId(db, 'DEC')
        db.decisions[id] = {
          id,
          reqId: req.id,
          kind: args.kind,
          decision: args.decision,
          rationale: args.rationale,
          dissent: args.dissent ?? '',
          at: nowIso(),
          by: agentId(exec),
        }
        req.decisions.push(id)
        refresh(req)
        events.push({ type: 'decision.record', reqId: req.id, decisionId: id, kind: args.kind })
        return { decisionId: id }
      }, events)
    }))

  tools.push(tool('dp_escalate',
    '把 REQ 挂起并上报用户（轮次耗尽 / 超出 Leader 能力）。Leader 专用。',
    params({
      reqId: S('REQ-ID'),
      question: S('要用户判断的问题'),
      context: S('上下文与可选方案'),
    }, ['reqId', 'question']),
    async (args, exec) => {
      if (!isRootAgent(ctx, exec.agent)) throw new Error('只有 Leader（根 Agent）可以上报用户')
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        if (isTerminal(req.state)) throw new Error(`REQ 已是终态：${req.state}`)
        if (req.state === 'blocked') throw new Error('REQ 已处于 blocked，等待 dp_escalation_resolve')
        req.blockedFrom = req.state
        req.pendingEscalation = {
          question: args.question,
          context: args.context ?? '',
          at: nowIso(),
          by: agentId(exec),
        }
        req.state = 'blocked'
        refresh(req)
        events.push({ type: 'req.escalate', reqId: req.id, question: args.question })
        return { reqId: req.id, state: 'blocked', blockedFrom: req.blockedFrom, needsUserDecision: true }
      }, events)
    }))

  tools.push(tool('dp_escalation_resolve',
    '用户给出判断后恢复 REQ。decision 记入决定记录，状态回到挂起前的状态。Leader 专用。',
    params({ reqId: S('REQ-ID'), decision: S('用户的判断'), note: S('补充说明（可选）') }, ['reqId', 'decision']),
    async (args, exec) => {
      if (!isRootAgent(ctx, exec.agent)) throw new Error('只有 Leader（根 Agent）可以恢复挂起的 REQ')
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        if (req.state !== 'blocked') throw new Error(`REQ 当前不是 blocked：${req.state}`)
        const from = req.state
        req.state = req.blockedFrom ?? 'draft'
        req.blockedFrom = null
        req.pendingEscalation = null
        const id = makeId(db, 'DEC')
        db.decisions[id] = { id, reqId: req.id, kind: 'user-escalation', decision: args.decision, rationale: args.note ?? '', at: nowIso(), by: agentId(exec) }
        req.decisions.push(id)
        req.history.push({ from, to: req.state, at: nowIso(), note: `用户判断：${args.decision}` })
        refresh(req)
        events.push({ type: 'req.escalation-resolve', reqId: req.id, decisionId: id })
        return { reqId: req.id, state: req.state, decisionId: id }
      }, events)
    }))

  tools.push(tool('dp_support_ticket',
    '把用户反馈转成结构化支持工单（步骤/期望/实际/阻塞/日志/复现频率）。',
    params({
      reqId: S('REQ-ID'),
      steps: S('操作步骤'),
      expected: S('期望结果'),
      actual: S('实际结果'),
      blockers: S('阻塞点'),
      logs: S('日志位置/摘要'),
      repro: S('复现频率与方法'),
    }, ['reqId', 'steps', 'expected', 'actual', 'repro']),
    async (args) => {
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        const id = makeId(db, 'TKT')
        db.tickets[id] = {
          id,
          reqId: req.id,
          steps: args.steps,
          expected: args.expected,
          actual: args.actual,
          blockers: args.blockers ?? '',
          logs: args.logs ?? '',
          repro: args.repro,
          status: 'open',
          createdAt: nowIso(),
        }
        req.tickets.push(id)
        refresh(req)
        events.push({ type: 'ticket.create', reqId: req.id, ticketId: id })
        return { ticketId: id }
      }, events)
    }))

  tools.push(tool('dp_log_deliver',
    '埋点团队交付调试期日志与调试信息（含 traceId / REQ-ID / 结构化 / 脱敏 / 动态级别说明）。',
    params({ reqId: S('REQ-ID'), summary: S('日志改动与检索方式'), traceId: S('traceId 约定（可选）') }, ['reqId', 'summary']),
    async (args, exec) => {
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        req.logging.delivered = true
        req.logging.debugSummary = args.summary
        req.logging.traceId = args.traceId ?? ''
        req.logging.deliveredAt = nowIso()
        refresh(req)
        events.push({ type: 'log.deliver', reqId: req.id, actor: agentId(exec) })
        return { reqId: req.id, delivered: true }
      }, events)
    }))

  tools.push(tool('dp_log_normalize',
    '操作验收通过后执行日志规范化（移除过程性日志；级别/采样/脱敏/性能/可检索）。',
    params({ reqId: S('REQ-ID'), summary: S('规范化说明'), checklist: S('自检清单（可选）') }, ['reqId', 'summary']),
    async (args, exec) => {
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        if (req.acceptance?.verdict !== 'pass') throw new Error('操作验收未通过，不能做日志规范化')
        req.logging.normalized = true
        req.logging.normalizeSummary = args.summary
        req.logging.normalizeChecklist = args.checklist ?? ''
        req.logging.normalizedAt = nowIso()
        refresh(req)
        events.push({ type: 'log.normalize', reqId: req.id, actor: agentId(exec) })
        return { reqId: req.id, normalized: true }
      }, events)
    }))

  tools.push(tool('dp_acceptance_verdict',
    '操作验收判定（公开层 + 保留层）。非根 Agent 无法对保留层给结论。',
    params({
      reqId: S('REQ-ID'),
      verdict: S('pass 或 fail'),
      summary: S('验收结论说明'),
      failedItems: A('失败项（可选）', S('描述')),
    }, ['reqId', 'verdict', 'summary']),
    async (args, exec) => {
      if (args.verdict !== 'pass' && args.verdict !== 'fail') throw new Error('verdict 必须是 pass 或 fail')
      const events = []
      return store.write((db) => {
        const req = getReq(db, args.reqId)
        if (req.state !== 'acceptance') throw new Error(`当前状态 ${req.state} 不接受验收判定，需先进入 acceptance`)
        if (args.verdict === 'fail') {
          assertRoundBudget(req.counters.acceptanceFail, cfg.rounds.acceptanceFail, '操作验收失败')
          req.counters.acceptanceFail += 1
        }
        req.acceptance = {
          verdict: args.verdict,
          summary: args.summary,
          failedItems: args.failedItems ?? [],
          at: nowIso(),
          by: agentId(exec),
        }
        refresh(req)
        events.push({ type: 'acceptance.verdict', reqId: req.id, verdict: args.verdict })
        return { reqId: req.id, verdict: args.verdict, failures: req.counters.acceptanceFail }
      }, events)
    }))

  tools.push(tool('dp_board',
    '导出一块看板（Markdown），用于人读与审计。',
    params({ reqId: S('REQ-ID（可选，缺省导出全部）') }, []),
    async (args, exec) => {
      return store.read((db) => {
        const visible = reservedVisible(ctx, exec.agent, cfg)
        const reqs = args.reqId ? [getReq(db, args.reqId)] : Object.values(db.reqs)
        return { markdown: boardMarkdown(reqs, cfg, visible) }
      })
    }))

  return tools
}

/** 简单看板渲染。 */
function boardMarkdown(reqs, cfg, withReserved) {
  const lines = ['# 交付协议看板', '', `生成时间：${nowIso()}`, '']
  for (const req of reqs) {
    lines.push(`## ${req.id} ${req.title}`)
    lines.push('', `- 状态：**${req.state}**`, `- 更新：${req.updatedAt}`)
    const publicCriteria = req.criteria.filter(c => c.layer === 'public')
    const reservedCriteria = req.criteria.filter(c => c.layer === 'reserved')
    lines.push(`- 公开验收：${publicCriteria.filter(c => c.verified.passed).length}/${publicCriteria.length} 通过`)
    lines.push(`- 保留验收：${withReserved ? `${reservedCriteria.filter(c => c.verified.passed).length}/${reservedCriteria.length} 通过` : `${reservedCriteria.length} 条（内容仅 Leader 可见）`}`)
    const open = req.issues.filter(i => i.status !== 'closed')
    lines.push(`- 未关闭 Issue：${open.length}`)
    lines.push(`- 设计互评轮次：${req.counters.mutualReview}/${cfg.rounds.mutualReview}`)
    lines.push(`- 验收失败次数：${req.counters.acceptanceFail}/${cfg.rounds.acceptanceFail}`)
    if (req.state === 'blocked' && req.pendingEscalation) {
      lines.push('', `> ⏸ 等待用户判断：${req.pendingEscalation.question}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 调用方标识（审计用）。 */
function agentId(exec) {
  const agent = exec?.agent
  return agent?.id ? String(agent.id) : 'unknown'
}

/**
 * 状态迁移核心：守卫 + 计数器 + 历史 + 事件。
 */
function transition(db, req, to, { exec, cfg, events, note }) {
  if (to === 'cancelled') throw new Error('取消请使用 dp_req_cancel')
  if (isTerminal(req.state)) throw new Error(`REQ 已是终态：${req.state}`)
  const allowed = nextStates(req.state)
  if (!allowed.includes(to)) {
    throw new Error(`非法迁移：${req.state} → ${to}（允许：${allowed.join('、') || '无'}）`)
  }
  const blocked = guardTransition(req, to, cfg, db)
  if (blocked) throw new Error(`迁移被守卫拒绝：${blocked}`)
  if (to === 'debugging') {
    assertRoundBudget(req.counters.acceptanceFail, cfg.rounds.acceptanceFail, '操作验收失败重试')
  }
  if (to === 'instrumenting' && req.state === 'debugging') {
    assertRoundBudget(req.counters.logRequest, cfg.rounds.logRequest, '调试期加日志')
    req.counters.logRequest += 1
  }
  if (to === 'acceptance' && req.state === 'fixing') {
    assertRoundBudget(req.counters.fixLoop, cfg.rounds.fixLoop, '修复复核循环')
    req.counters.fixLoop += 1
  }
  const from = req.state
  req.state = to
  req.history.push({ from, to, at: nowIso(), note: note ?? '' })
  refresh(req)
  events.push({ type: 'req.transition', reqId: req.id, from, to, actor: agentId(exec) })
  return { reqId: req.id, from, to, state: to, allowedNext: nextStates(to) }
}
