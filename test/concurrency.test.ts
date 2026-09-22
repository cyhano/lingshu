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

  test('并发创建同题笔记（如当天日报）：恰好一个 201 其余 409 duplicate_title', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        req(env.app, 'POST', '/notes', { title: '04-日报/日报/2026-09-21.md', content_md: `内容-${i}` }, `d${i}`),
      ),
    )
    const created = results.filter((r) => r.status === 201)
    const dups = results.filter((r) => r.status === 409)
    expect(created.length).toBe(1)
    expect(dups.length).toBe(4)
    expect(dups.every((r) => r.json.error === 'duplicate_title')).toBe(true)
    // 409 响应带已有笔记 id，引导合并而非新建
    expect(dups[0].json.id).toBe(created[0].json.id)
  })

  test('多会话并发 append（免锁追加，如各自补日报）：全部成功、内容都在', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: '并发追加目标', content_md: '# 日报\n\n开头。' })
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        req(env.app, 'PATCH', `/notes/${json.id}`, { op: 'append', content_md: `- 条目 ${i}（by a${i}）` }, `a${i}`),
      ),
    )
    expect(results.every((r) => r.status === 200)).toBe(true)
    const final = await req(env.app, 'GET', `/notes/${json.id}`)
    // 8 条追加一个不丢，版本 +8
    for (let i = 0; i < 8; i++) expect(final.json.content_md).toContain(`- 条目 ${i}（by a${i}）`)
    expect(final.json.version).toBe(9)
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
