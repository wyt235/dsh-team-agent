/**
 * @dsh-external/delivery-protocol — Host 侧入口。
 *
 * 只做三件事：
 *  1. 归一化配置（轮次全部可配）；
 *  2. 初始化协议存储（工作区之外，保留层不落共享盘）；
 *  3. 注册 dp_* 工具集（状态机 / 看板 / 意见与裁决 / worktree 隔离）。
 *
 * 不依赖 agent-team，也不依赖实验性 worktree 包：执行层用 subagent/workflow，
 * 隔离用 git worktree 命令自实现。
 */
import { normalizeConfig } from './lib/config.js'
import { createStore } from './lib/store.js'
import { createTools } from './lib/tools.js'

export const name = '@dsh-external/delivery-protocol'

/** 需要 Host 工具注册表；Agent 注册表（判断调用方是否根 Agent）在调用时按需读取。 */
export const inject = ['tools']

/**
 * @param {import('cordis').Context} ctx
 * @param {unknown} config 插件行 config
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const store = createStore(cfg)
  const tools = createTools({ ctx, cfg, store })

  for (const definition of tools) {
    ctx.effect(() => ctx.tools.register(definition))
  }
}
