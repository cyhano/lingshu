// test/concurrency.test.ts — 多 Agent 并发写 / 乐观锁竞争 / 事件流完整性

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestEnv, req, TestEnv } from './helpers.ts'

let env: TestEnv
beforeEach(() => { env = createTestEnv() })
afterEach(() => { env.cleanup() })

describe('并发写', () => {
  test('10 个 actor 并发 PUT 全部成功，版本连续，快照完整', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: '并发目标', content_md: '初始' })
    const id = json.id

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        req(env.app, 'PUT', `/notes/${id}`, { content_md: `写入 by a${i}` }, `a${i}`),
      ),
    )
    expect(results.every((r) => r.status === 200)).toBe(true)

    const final = await req(env.app, 'GET', `/notes/${id}`)
    expect(final.json.version).toBe(11)
    expect(final.json.updated_by).toMatch(/^a\d$/)

    const vs = await req(env.app, 'GET', `/notes/${id}/versions`)
    expect(vs.json.length).toBe(10)
  })

  test('乐观锁：同 version 并发竞争，恰好一个成功其余 409', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: '锁竞争', content_md: 'v1' })
    const id = json.id

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        req(env.app, 'PUT', `/notes/${id}`, { content_md: `b${i}`, version: 1 }, `b${i}`),
      ),
    )
    const oks = results.filter((r) => r.status === 200)
    const conflicts = results.filter((r) => r.status === 409)
    // 串行化后：第一个成功，后续 version 已变 → 409
    expect(oks.length).toBe(1)
    expect(conflicts.length).toBe(4)
  })

  test('并发创建不同笔记互不干扰', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        req(env.app, 'POST', '/notes', { title: `并发创建-${i}`, content_md: `内容-${i}` }, `c${i}`),
      ),
    )
    expect(results.every((r) => r.status === 201)).toBe(true)
    const ids = new Set(results.map((r) => r.json.id))
    expect(ids.size).toBe(8)

    const changes = await req(env.app, 'GET', '/changes?since=0')
    expect(changes.json.length).toBe(8)
  })

  test('并发读写在 WAL 下无死锁（50 读 + 10 写混合）', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: '混合负载', content_md: '初始' })
    const id = json.id
    const ops: Promise<unknown>[] = []
    for (let i = 0; i < 50; i++) ops.push(req(env.app, 'GET', `/notes/${id}`))
    for (let i = 0; i < 10; i++) ops.push(req(env.app, 'PUT', `/notes/${id}`, { content_md: `写-${i}` }, `w${i}`))
    await Promise.all(ops) // 不抛错即通过
    const final = await req(env.app, 'GET', `/notes/${id}`)
    expect(final.json.version).toBe(11)
  })
})
