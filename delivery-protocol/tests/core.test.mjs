/**
 * 纯逻辑测试：不启动 DSH 宿主，用假 ctx 驱动工具执行。
 * 运行：node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig, DEFAULT_ROUNDS } from '../lib/config.js'
import { guardTransition, assertRoundBudget, nextStates } from '../lib/state.js'
import { createStore, makeId } from '../lib/store.js'
import { createTools } from '../lib/tools.js'

const lead = { id: 'lead-session' }
const coder = { id: 'coder-session' }

async function setup(overrides = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'dp-test-'))
  const cfg = normalizeConfig({ rootDir, ...overrides })
  const store = createStore(cfg)
  const ctx = { get: name => (name === 'agents' ? { roots: () => [lead] } : undefined) }
  const tools = createTools({ ctx, cfg, store })
  const byName = new Map(tools.map(t => [t.name, t]))
  const exec = agent => ({ agent, signal: new AbortController().signal })
  const call = (name, args, agent = lead) => byName.get(name).execute(args, exec(agent))
  return { cfg, store, tools, call, rootDir }
}

test('配置：默认轮次与非法值', () => {
  const cfg = normalizeConfig({})
  assert.deepEqual(cfg.rounds, DEFAULT_ROUNDS)
  assert.equal(cfg.onExhausted, 'ask-user')
  assert.throws(() => normalizeConfig({ rounds: { battle: -1 } }), /非负整数/)
  assert.throws(() => normalizeConfig({ rounds: { battle: 1.5 } }), /非负整数/)
  assert.throws(() => normalizeConfig({ onExhausted: 'leader' }), /ask-user/)
  assert.throws(() => normalizeConfig({ codingMaxParallel: 0 }), /正整数/)
})

test('状态机：守卫按证据要求拦截', () => {
  const cfg = normalizeConfig({})
  const req = { state: 'designing', design: { submissions: {} }, criteria: [], tasks: [], issues: [], logging: {} }
  assert.match(guardTransition(req, 'design_review', cfg), /两个设计/)
  req.design.submissions = { A: { content: 'a' }, B: { content: 'b' } }
  assert.equal(guardTransition(req, 'design_review', cfg), null)
  assert.match(guardTransition({ ...req, state: 'design_fixed', criteria: [], tasks: [], issues: [] }, 'coding', cfg), /public/)
  assert.deepEqual(nextStates('closed'), [])
  assert.throws(() => assertRoundBudget(2, 2, '互评'), err => err.code === 'ROUND_EXHAUSTED')
})

test('完整主链：设计→编码→审码→埋点→验收→关闭', async () => {
  const { call, cfg } = await setup()
  const { reqId } = await call('dp_req_open', { title: '示例需求' })

  await call('dp_criteria_add', { reqId, layer: 'public', text: '接口返回正确', check: '单测' })
  await call('dp_criteria_add', { reqId, layer: 'reserved', text: '真实操作链可用' })

  await call('dp_req_transition', { reqId, to: 'designing' })
  await call('dp_design_submit', { reqId, slot: 'A', content: '方案A' })
  await call('dp_design_submit', { reqId, slot: 'B', content: '方案B' })
  await call('dp_req_transition', { reqId, to: 'design_review' })

  for (let round = 0; round < cfg.rounds.mutualReview; round++) {
    await call('dp_design_review', { reqId, reviewer: 'A', target: 'B', claims: 'B 有问题', evidence: 'e1' })
    await call('dp_design_review', { reqId, reviewer: 'B', target: 'A', claims: 'A 有问题', evidence: 'e2' })
  }
  await assert.rejects(
    call('dp_design_review', { reqId, reviewer: 'A', target: 'B', claims: '超额', evidence: 'e' }),
    /轮次已耗尽/,
  )

  await call('dp_design_arbitrate', { reqId, decision: 'merge', rationale: '融合两者优点' })
  const afterArbitration = await call('dp_req_get', { reqId })
  assert.equal(afterArbitration.state, 'design_fixed')

  await call('dp_req_transition', { reqId, to: 'coding' })
  const { taskId } = await call('dp_task_create', { reqId, module: 'api', files: ['src/api'] })
  await call('dp_task_submit', { taskId, summary: '实现接口', tests: '3 passed' })
  await call('dp_ci_gate', { reqId, passed: true, details: 'build+tests ok' })
  await call('dp_req_transition', { reqId, to: 'code_review' })

  const { issueId } = await call('dp_issue_open', {
    reqId, severity: 'normal', module: 'api', title: '边界未处理', description: '空数组崩溃', evidence: 'repro',
  })
  await call('dp_issue_respond', {
    issueId, action: 'reject', basis: '入参已校验', evidence: 'test case', alternative: '无需修改', risk: '低',
  })
  await call('dp_issue_adjudicate', { issueId, verdict: 'reject-valid', rationale: '证据充分' })
  await call('dp_req_transition', { reqId, to: 'instrumenting' })

  await call('dp_log_deliver', { reqId, summary: 'traceId 已统一' })
  await call('dp_req_transition', { reqId, to: 'acceptance' })
  await call('dp_acceptance_verdict', { reqId, verdict: 'pass', summary: '用户确认可用' })

  const board = await call('dp_board', { reqId })
  assert.match(board.markdown, /保留验收/)

  const publicCriterion = (await call('dp_criteria_list', { reqId, layer: 'public' })).items[0]
  await call('dp_criteria_verify', { reqId, criterionId: publicCriterion.id, passed: true, evidence: '单测通过' })
  const reservedCriterion = (await call('dp_criteria_list', { reqId, layer: 'reserved' })).items[0]
  await call('dp_criteria_verify', { reqId, criterionId: reservedCriterion.id, passed: true, evidence: '用户验收' })

  await call('dp_req_transition', { reqId, to: 'normalizing' })
  await call('dp_log_normalize', { reqId, summary: '移除过程性日志' })
  await call('dp_req_transition', { reqId, to: 'closed' })
  const closed = await call('dp_req_get', { reqId })
  assert.equal(closed.state, 'closed')
})

test('保留层：非根 Agent 只能看到数量，不可判定', async () => {
  const { call } = await setup()
  const { reqId } = await call('dp_req_open', { title: '保留层测试' })
  await call('dp_criteria_add', { reqId, layer: 'reserved', text: '隐藏验收项' })

  const visibleToLead = (await call('dp_criteria_list', { reqId })).items
  assert.equal(visibleToLead.length, 1)
  assert.equal(visibleToLead[0].text, '隐藏验收项')

  const visibleToCoder = (await call('dp_criteria_list', { reqId }, coder)).items
  assert.equal(visibleToCoder.length, 0)

  const viewForCoder = await call('dp_req_get', { reqId }, coder)
  assert.equal(viewForCoder.reserved.count, 1)
  assert.equal(viewForCoder.criteria.length, 0)

  await assert.rejects(
    call('dp_criteria_add', { reqId, layer: 'reserved', text: '偷写' }, coder),
    /只有 Leader/,
  )
})

test('轮次耗尽：验收失败超限后必须先上报用户', async () => {
  const { call, cfg } = await setup()
  const { reqId } = await call('dp_req_open', { title: '验收循环' })
  await call('dp_criteria_add', { reqId, layer: 'public', text: '可验收' })
  await call('dp_req_transition', { reqId, to: 'designing' })
  await call('dp_design_submit', { reqId, slot: 'A', content: 'A' })
  await call('dp_design_submit', { reqId, slot: 'B', content: 'B' })
  await call('dp_req_transition', { reqId, to: 'design_review' })
  await call('dp_design_arbitrate', { reqId, decision: 'A', rationale: 'A 更稳' })
  await call('dp_req_transition', { reqId, to: 'coding' })
  const { taskId } = await call('dp_task_create', { reqId, module: 'm', files: ['m'] })
  await call('dp_task_submit', { taskId, summary: 's' })
  await call('dp_ci_gate', { reqId, passed: true, details: 'ok' })
  await call('dp_req_transition', { reqId, to: 'code_review' })
  await call('dp_req_transition', { reqId, to: 'instrumenting' })
  await call('dp_log_deliver', { reqId, summary: 'log' })
  await call('dp_req_transition', { reqId, to: 'acceptance' })
  await call('dp_support_ticket', { reqId, steps: 's', expected: 'e', actual: 'a', repro: 'always' })

  // 第一次失败：进入调试，再回到验收
  await call('dp_acceptance_verdict', { reqId, verdict: 'fail', summary: '第一次失败' })
  await call('dp_req_transition', { reqId, to: 'debugging' })
  await call('dp_req_transition', { reqId, to: 'instrumenting' })
  await call('dp_req_transition', { reqId, to: 'acceptance' })
  // 第二次失败：计数达到上限，不允许再进调试
  await call('dp_acceptance_verdict', { reqId, verdict: 'fail', summary: '第二次失败' })
  await assert.rejects(
    call('dp_req_transition', { reqId, to: 'debugging' }),
    /轮次已耗尽/,
  )
  // 继续失败也被拒绝
  await assert.rejects(
    call('dp_acceptance_verdict', { reqId, verdict: 'fail', summary: '第三次失败' }),
    /轮次已耗尽/,
  )
  assert.equal(cfg.rounds.acceptanceFail, 2)

  const escalated = await call('dp_escalate', { reqId, question: '验收连续失败，是否回设计？' })
  assert.equal(escalated.state, 'blocked')
  await assert.rejects(
    call('dp_req_transition', { reqId, to: 'normalizing' }),
    /终态|非法迁移/,
  )
  const resolved = await call('dp_escalation_resolve', { reqId, decision: '回设计重做', note: '用户决定' })
  assert.equal(resolved.state, 'acceptance')
})

test('存储：跨实例持久化与事件流', async () => {
  const { call, rootDir } = await setup()
  const { reqId } = await call('dp_req_open', { title: '持久化' })
  const store2 = createStore(normalizeConfig({ rootDir }))
  const req = await store2.read(db => db.reqs[reqId])
  assert.equal(req.title, '持久化')
  const events = await readFile(join(rootDir, 'events.jsonl'), 'utf8')
  assert.match(events, /req\.open/)
})

test('ID 生成：同日递增', () => {
  const db = { seq: {} }
  const a = makeId(db, 'REQ')
  const b = makeId(db, 'REQ')
  assert.notEqual(a, b)
  assert.match(a, /^REQ-\d{8}-001$/)
  assert.match(b, /^REQ-\d{8}-002$/)
})
