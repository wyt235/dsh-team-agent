/**
 * 冒烟测试：用假 ctx 走一遍 apply()，确认工具集能注册、参数/输出 schema 在支持子集内。
 * 运行：node tests/smoke.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const registered = []
const ctx = {
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
  effect: (fn) => fn(),
  get: (name) => (name === 'agents' ? { roots: () => [] } : undefined),
}

apply(ctx, {
  rounds: { mutualReview: 1, battle: 1 },
})

assert.equal(registered.length, 28, `工具数量应为 28，实际 ${registered.length}`)
const names = new Set(registered.map(d => d.name))
for (const name of names) assert.match(name, /^dp_/)

const SUPPORTED_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'title', 'description', 'default', 'examples',
])

function checkSchema(node, path) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) throw new Error(`${path} 不是 schema 对象`)
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYS.has(key)) throw new Error(`${path}.${key} 不是受支持的 schema 关键字`)
  }
  if (node.type !== undefined) {
    assert.ok(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(node.type), `${path}.type 非法`)
  }
  if (node.properties !== undefined) {
    for (const [key, child] of Object.entries(node.properties)) checkSchema(child, `${path}.properties.${key}`)
  }
  if (node.items !== undefined) checkSchema(node.items, `${path}.items`)
  if (node.oneOf !== undefined) node.oneOf.forEach((child, i) => checkSchema(child, `${path}.oneOf[${i}]`))
}

for (const definition of registered) {
  assert.equal(typeof definition.description, 'string')
  assert.ok(definition.description.length > 0)
  checkSchema(definition.parameters, `${definition.name}.parameters`)
  assert.equal(definition.parameters.type, 'object')
  assert.equal(typeof definition.output.render, 'function')
  checkSchema(definition.output.schema, `${definition.name}.output.schema`)
  const blocks = definition.output.render({}, { ok: true })
  assert.equal(blocks[0].type, 'text')
  assert.equal(typeof definition.execute, 'function')
}

console.log(`smoke ok: ${registered.length} tools registered`)
