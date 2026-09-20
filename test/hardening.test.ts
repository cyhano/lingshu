// test/hardening.test.ts — 二次审计修复的回归用例：
// 数值参数防 500 / trash 计数 / embedding_ready 上报 / 坏向量容错 / drainAll 收敛

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestEnv, req, TestEnv } from './helpers.ts'
import { cosineSimilarity } from '../src/embed/embedder.ts'

let env: TestEnv
beforeEach(() => { env = createTestEnv() })
afterEach(() => { env.cleanup() })

describe('数值参数防 500（numOr）', () => {
  beforeEach(async () => {
    await req(env.app, 'POST', '/notes', { title: 'A', content_md: 'a' })
  })

  test('?limit=abc → 200 且用默认值', async () => {
    const { status, json } = await req(env.app, 'GET', '/notes?limit=abc')
    expect(status).toBe(200)
    expect(json.length).toBe(1)
  })

  test('?limit=0 / 负数 / Infinity → 钳到合法范围', async () => {
    expect((await req(env.app, 'GET', '/notes?limit=0')).status).toBe(200)
    expect((await req(env.app, 'GET', '/notes?limit=-5')).status).toBe(200)
    expect((await req(env.app, 'GET', '/notes?limit=1e999')).status).toBe(200)
  })

  test('/search limit=abc → 200', async () => {
    const { status } = await req(env.app, 'GET', '/search?q=a&limit=abc')
    expect(status).toBe(200)
  })

  test('/changes?since=abc → 200 且不静默吞事件', async () => {
    // 制造一条变更
    await req(env.app, 'POST', '/notes', { title: 'B', content_md: 'b' })
    // since=abc 应回落为 0（而非 NaN 导致 WHERE id > NaN 恒空）
    const { status, json } = await req(env.app, 'GET', '/changes?since=abc')
    expect(status).toBe(200)
    expect(json.length).toBe(2)
  })

  test('/changes limit 透传', async () => {
    await req(env.app, 'POST', '/notes', { title: 'B', content_md: 'b' })
    const { json } = await req(env.app, 'GET', '/changes?since=0&limit=1')
    expect(json.length).toBe(1)
  })
})

describe('trash/count 无截断', () => {
  test('软删笔记计数正确（不受 list 500 条限制影响）', async () => {
    for (let i = 0; i < 3; i++) {
      const { json } = await req(env.app, 'POST', '/notes', { title: `n${i}`, content_md: 'x' })
      await req(env.app, 'DELETE', `/notes/${json.id}`)
    }
    const { json } = await req(env.app, 'GET', '/trash/count')
    expect(json.count).toBe(3)
  })
})

describe('embedding_ready 状态上报', () => {
  test('FakeEmbedder 环境下为 true', async () => {
    const { json } = await req(env.app, 'GET', '/status')
    expect(json.embedding_ready).toBe(true)
  })
})

describe('坏向量容错（vectorRank 不 500）', () => {
  test('损坏的 embedding 字节数非 4 倍数被跳过，其余正常召回', async () => {
    await req(env.app, 'POST', '/notes', { title: '好笔记', content_md: '正常内容独特词琥珀' })
    await env.pipeline.processBatch(64)

    // 手工破坏一个向量：写入字节数非 4 倍数的 BLOB（模拟损坏数据）
    ;(env.repo as any).db.query("UPDATE chunks SET embedding = ? WHERE embedding IS NOT NULL").run(new Uint8Array([1, 2, 3, 4, 5, 6]))

    // 不应 500；FTS 路仍可命中
    const { status, json } = await req(env.app, 'POST', '/recall', { query: '琥珀', k: 3 })
    expect(status).toBe(200)
    expect(json.length).toBeGreaterThan(0)
    expect(json[0].title).toBe('好笔记')
  })

  test('维度混存（模型升级场景）：旧维度向量静默归零不炸', async () => {
    await req(env.app, 'POST', '/notes', { title: '维A', content_md: '维度测试内容一' })
    await env.pipeline.processBatch(64)
    // 把某个 8 维向量改成 9 维（36 字节，模拟换模型后的混存）
    const emb = (env.repo as any).db.query('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1').get() as { id: number; embedding: Uint8Array }
    const wrong = new Uint8Array(9 * 4) // 9 维 → 36 字节
    wrong.set(emb.embedding.subarray(0, 32))
    ;(env.repo as any).db.query('UPDATE chunks SET embedding = ? WHERE id = ?').run(wrong, emb.id)

    const { status } = await req(env.app, 'POST', '/recall', { query: '维度测试', k: 3 })
    expect(status).toBe(200)
  })
})

describe('cosineSimilarity 边界（纯函数）', () => {
  test('不等长 / 零向量 / null → 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0)
    expect(cosineSimilarity(null, [1])).toBe(0)
    expect(cosineSimilarity([1, 0], null)).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })

  test('正常向量方向一致为 1，正交为 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })
})

describe('drainAll 收敛', () => {
  test('大量脏 chunk 全部消化', async () => {
    // 造 5 篇多块笔记（每篇 >12 块）
    for (let i = 0; i < 5; i++) {
      const md = `# 标题${i}\n\n` + Array.from({ length: 12 }, (_, j) => `段${j} ${'填充内容。'.repeat(30)}`).join('\n\n')
      await req(env.app, 'POST', '/notes', { title: `批量${i}`, content_md: md })
    }
    expect(env.repo.dirtyCount()).toBeGreaterThan(30)
    await env.pipeline.drainAll()
    expect(env.repo.dirtyCount()).toBe(0)
    // /embed/drain 路由
    await req(env.app, 'POST', '/notes', { title: '再补一篇', content_md: '更多内容'.repeat(60) })
    const r = await req(env.app, 'POST', '/embed/drain')
    expect(r.json.ok).toBe(true)
    expect(r.json.pending).toBe(0)
  })
})
