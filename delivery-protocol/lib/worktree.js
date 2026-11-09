/**
 * 轻量 git worktree 封装：不依赖实验性 worktree 插件。
 *
 * 设计取舍：
 *  - 现有 packages/experimental/worktree 是“给当前 session 切 cwd + 沙箱授权”的完整实现，
 *    依赖面大且默认关闭；交付协议需要的是“一个任务一个分支/worktree，由协调者记录映射”，
 *    直接用 git 命令更可控。
 *  - 失败不自动清理：保留现场便于排查（与现有 worktree 包的行为一致）。
 */
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 执行 git 命令并取 stdout。
 * @param {string} cwd
 * @param {string[]} args
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
function git(cwd, args, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', ['-C', cwd, ...args], {
      signal,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`git ${args.join(' ')} 失败：${(stderr || error.message).trim()}`))
        return
      }
      resolvePromise(String(stdout).trim())
    })
  })
}

/**
 * 解析仓库根与基线提交。
 * @param {string} cwd
 * @param {string} baseRef
 * @param {AbortSignal} [signal]
 */
export async function resolveRepo(cwd, baseRef, signal) {
  const root = await git(cwd, ['rev-parse', '--show-toplevel'], signal)
  const baseCommit = await git(root, ['rev-parse', '--verify', `${baseRef}^{commit}`], signal)
  return { root, baseCommit }
}

/**
 * 为一个编码任务建独立 worktree。
 * @param {object} options
 * @param {string} options.repoRoot 仓库根（或仓库内任意路径）
 * @param {string} options.branch 新分支名，同时作为 worktree 目录名
 * @param {string} [options.dir] 相对仓库根的 worktree 池，默认 .agents/worktrees
 * @param {string} [options.baseRef] 基线 revision，默认 HEAD
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{root: string, path: string, branch: string, baseCommit: string}>}
 */
export async function createWorktree({ repoRoot, branch, dir = '.agents/worktrees', baseRef = 'HEAD', signal }) {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..')) {
    throw new Error(`非法分支名：${branch}`)
  }
  const { root, baseCommit } = await resolveRepo(repoRoot, baseRef, signal)
  // 先检查分支是否存在，避免 git 报错信息难读
  const existing = await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], signal)
    .then(() => true, () => false)
  if (existing) throw new Error(`分支已存在：${branch}`)
  const path = join(root, dir, branch)
  await mkdir(join(root, dir), { recursive: true })
  await git(root, ['worktree', 'add', '-b', branch, '--', path, baseCommit], signal)
  return { root, path, branch, baseCommit }
}

/**
 * 移除 worktree（保留分支），用于任务收尾。
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.path
 * @param {AbortSignal} [options.signal]
 */
export async function removeWorktree({ repoRoot, path, signal }) {
  const { root } = await resolveRepo(repoRoot, 'HEAD', signal)
  await git(root, ['worktree', 'remove', '--force', '--', path], signal)
  return { removed: path }
}

/**
 * 列出当前 worktree。
 * @param {string} repoRoot
 * @param {AbortSignal} [signal]
 */
export async function listWorktrees(repoRoot, signal) {
  const { root } = await resolveRepo(repoRoot, 'HEAD', signal)
  const porcelain = await git(root, ['worktree', 'list', '--porcelain'], signal)
  return porcelain.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
}
