// test/feedback.test.ts — 召回反馈闭环 + 召回 heading 粒度

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestEnv, req, TestEnv } from './helpers.ts'

let env: TestEnv
beforeEach(() => { env = createTestEnv() })
afterEach(() => { env.cleanup() })

describe('召回反馈', () => {
  test('记录 hit/miss，非法 verdict → 400', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: '样本', content_md: '# 标题\n\n内容' })
    const id = json.id

    const ok = await req(env.app, 'POST', `/recall/${id}/feedback`, { query: '测试', verdict: 'hit' }, 'dsh')
    expect(ok.status).toBe(200)
    expect(ok.json.verdict).toBe('hit')

    const miss = await req(env.app, 'POST', `/recall/${id}/feedback`, { query: '测试2', verdict: 'miss' }, 'zcode')
    expect(miss.status).toBe(200)

    const bad = await req(env.app, 'POST', `/recall/${id}/feedback`, { verdict: 'maybe' })
    expect(bad.status).toBe(400)
    expect(bad.json.error).toBe('bad_request')
  })

  test('feedbackStats 按 miss 降序聚合，带标题', async () => {
    const { json: a } = await req(env.app, 'POST', '/notes', { title: '差笔记', content_md: 'x' })
    const { json: b } = await req(env.app, 'POST', '/notes', { title: '好笔记', content_md: 'y' })

    // 差笔记 3 miss，好笔记 2 hit
    for (let i = 0; i < 3; i++) await req(env.app, 'POST', `/recall/${a.id}/feedback`, { verdict: 'miss' })
    for (let i = 0; i < 2; i++) await req(env.app, 'POST', `/recall/${b.id}/feedback`, { verdict: 'hit' })

    const { json } = await req(env.app, 'GET', '/recall/feedback')
    expect(json[0].note_id).toBe(a.id) // miss 多的排前面
    expect(json[0].title).toBe('差笔记')
    expect(json[0].miss).toBe(3)
    expect(json[0].hit).toBe(0)
    expect(json[1].note_id).toBe(b.id)
    expect(json[1].hit).toBe(2)
    expect(json[1].miss).toBe(0)
  })

  test('反馈不存在的笔记 → 404', async () => {
    const r = await req(env.app, 'POST', '/recall/ghost/feedback', { verdict: 'hit' })
    expect(r.status).toBe(404)
  })
})

describe('召回 heading 粒度', () => {
  test('语义召回命中带 heading 字段（所属标题路径）', async () => {
    await req(env.app, 'POST', '/notes', {
      title: '多章节',
      content_md: '# 总标题\n\n## 已知坑\n\n某段独特内容一\n\n## 优化点\n\n某段独特内容二',
    })
    await env.pipeline.processBatch(64) // 向量化

    const { json } = await req(env.app, 'POST', '/recall', { query: '已知坑', k: 3 })
    expect(json.length).toBeGreaterThan(0)
    // 命中的 chunk 应带 heading（可能是「## 已知坑」或标题路径）
    expect(json[0].heading).toBeDefined()
    expect(json[0].heading).toContain('已知坑')
  })
})
