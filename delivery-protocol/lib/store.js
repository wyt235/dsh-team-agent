/**
 * 协议数据存储。
 *
 * - 数据放在工作区之外（默认 ~/.dsh/delivery-protocol），避免保留层验收标准被
 *   同工作区的其他 Agent 直接读到；保留层的读还叠加了工具层身份守卫。
 * - 单进程串行：所有读写走同一 Promise 队列；写盘用 临时文件 + rename 原子替换。
 * - events.jsonl 是审计流：每个动作一条，保证“每条箭头留痕”。
 */
import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** @param {object} cfg 归一化配置 */
export function resolveRootDir(cfg) {
  return cfg.rootDir ? resolve(cfg.rootDir) : join(homedir(), '.dsh', 'delivery-protocol')
}

function emptyDb() {
  return { version: 1, seq: {}, reqs: {}, issues: {}, tasks: {}, tickets: {}, decisions: {} }
}

/** 当天递增序号，生成可读 ID。 */
export function makeId(db, kind) {
  const now = new Date()
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const key = `${kind}:${day}`
  const next = (db.seq[key] ?? 0) + 1
  db.seq[key] = next
  return `${kind}-${day}-${String(next).padStart(3, '0')}`
}

/** @param {object} cfg 归一化配置 */
export function createStore(cfg) {
  const rootDir = resolveRootDir(cfg)
  const dbFile = join(rootDir, 'db.json')
  const eventsFile = join(rootDir, 'events.jsonl')
  /** @type {any} */
  let data = null
  let tail = Promise.resolve()

  /** 串行执行，保证单进程内读写不交错。 */
  function serialize(task) {
    const run = tail.then(task, task)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  async function load() {
    if (data) return data
    try {
      data = JSON.parse(await readFile(dbFile, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      data = emptyDb()
    }
    return data
  }

  async function persist() {
    await mkdir(rootDir, { recursive: true })
    const tmp = `${dbFile}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, dbFile)
  }

  /**
   * 只读事务：回调拿到深拷贝，随便改都不会污染真值。
   * @template T
   * @param {(db: any) => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  function read(fn) {
    return serialize(async () => {
      const db = await load()
      return await fn(structuredClone(db))
    })
  }

  /**
   * 写事务：回调直接改 db，返回后落盘并追加事件。
   * @template T
   * @param {(db: any) => T | Promise<T>} fn
   * @param {Array<Record<string, unknown>>} [events] 本事务产生的审计事件
   * @returns {Promise<T>}
   */
  function write(fn, events = []) {
    return serialize(async () => {
      const db = await load()
      const result = await fn(db)
      await persist()
      if (events.length > 0) {
        await mkdir(rootDir, { recursive: true })
        const lines = events.map(event => JSON.stringify({
          at: new Date().toISOString(),
          ...event,
        })).join('\n')
        await appendFile(eventsFile, `${lines}\n`, 'utf8')
      }
      return result
    })
  }

  return { rootDir, dbFile, eventsFile, read, write }
}
