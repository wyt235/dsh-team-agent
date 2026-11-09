/**
 * 配置归一化：插件行的 config 会原样传进来，这里只做白名单合并与校验。
 * 设计原则：所有“限 N 轮”都是配置项；v1 超限行为固定为 ask-user（交给用户判断）。
 */

/** 各机制默认轮次。全部可在插件行 config.rounds 覆盖。 */
export const DEFAULT_ROUNDS = Object.freeze({
  /** 设计阶段双 WorkAgent 互评轮次 */
  mutualReview: 2,
  /** 审码-编码 1v1 Battle 轮次 */
  battle: 2,
  /** 修复 → 复核 → 再验收的循环次数 */
  fixLoop: 2,
  /** 调试期“加日志”请求轮次 */
  logRequest: 2,
  /** 操作验收失败次数（达到即阻塞上报） */
  acceptanceFail: 2,
  /** 普通 Issue 被拒后 Leader 裁决轮次 */
  rejectAdjudicate: 1,
})

/** 完整默认配置 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 协议数据目录；空串表示 <home>/.dsh/delivery-protocol */
  rootDir: '',
  rounds: DEFAULT_ROUNDS,
  /** v1 固定 ask-user：任何轮次耗尽都阻塞并上报用户 */
  onExhausted: 'ask-user',
  /** 并行编码上限（业务约束，插件不改并发，只校验声明值） */
  codingMaxParallel: 3,
  worktree: {
    /** 相对仓库根的 worktree 池 */
    dir: '.agents/worktrees',
    /** 新分支的基线 revision */
    baseRef: 'HEAD',
    /** 仓库根；空串表示使用调用方给的 repoRoot 或进程 cwd */
    repoRoot: '',
  },
  reserved: {
    /** 是否启用保留层验收 */
    enabled: true,
    /** 保留层仅允许根 Agent（Lead）读写 */
    rootOnly: true,
  },
})

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0
}

function assertRound(value, key) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`delivery-protocol: config.rounds.${key} 必须是非负整数，收到 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 合并并校验配置。
 * @param {unknown} raw 插件行 config
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const roundsIn = input.rounds !== null && typeof input.rounds === 'object' && !Array.isArray(input.rounds)
    ? input.rounds
    : {}
  const rounds = {}
  for (const key of Object.keys(DEFAULT_ROUNDS)) {
    rounds[key] = assertRound(Object.hasOwn(roundsIn, key) ? roundsIn[key] : DEFAULT_ROUNDS[key], key)
  }
  const worktreeIn = input.worktree !== null && typeof input.worktree === 'object' && !Array.isArray(input.worktree)
    ? input.worktree
    : {}
  const reservedIn = input.reserved !== null && typeof input.reserved === 'object' && !Array.isArray(input.reserved)
    ? input.reserved
    : {}
  const codingMaxParallel = Object.hasOwn(input, 'codingMaxParallel') ? input.codingMaxParallel : DEFAULT_CONFIG.codingMaxParallel
  if (!isPositiveInt(codingMaxParallel)) {
    throw new Error(`delivery-protocol: config.codingMaxParallel 必须是正整数，收到 ${JSON.stringify(codingMaxParallel)}`)
  }
  const onExhausted = Object.hasOwn(input, 'onExhausted') ? input.onExhausted : DEFAULT_CONFIG.onExhausted
  if (onExhausted !== 'ask-user') {
    throw new Error(`delivery-protocol: v1 只支持 config.onExhausted = "ask-user"，收到 ${JSON.stringify(onExhausted)}`)
  }
  const rootDir = Object.hasOwn(input, 'rootDir') ? String(input.rootDir ?? '') : DEFAULT_CONFIG.rootDir
  return {
    rootDir,
    rounds,
    onExhausted,
    codingMaxParallel,
    worktree: {
      dir: worktreeIn.dir === undefined ? DEFAULT_CONFIG.worktree.dir : String(worktreeIn.dir),
      baseRef: worktreeIn.baseRef === undefined ? DEFAULT_CONFIG.worktree.baseRef : String(worktreeIn.baseRef),
      repoRoot: worktreeIn.repoRoot === undefined ? DEFAULT_CONFIG.worktree.repoRoot : String(worktreeIn.repoRoot),
    },
    reserved: {
      enabled: reservedIn.enabled === undefined ? DEFAULT_CONFIG.reserved.enabled : Boolean(reservedIn.enabled),
      rootOnly: reservedIn.rootOnly === undefined ? DEFAULT_CONFIG.reserved.rootOnly : Boolean(reservedIn.rootOnly),
    },
  }
}
