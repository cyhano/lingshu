// test/search.test.ts — FTS / LIKE 兜底 / 特殊字符 / 语义召回（FakeEmbedder）

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestEnv, req, TestEnv } from './helpers.ts'

let env: TestEnv
beforeEach(() => { env = createTestEnv() })
afterEach(() => { env.cleanup() })

describe('FTS 搜索', () => {
  beforeEach(async () => {
    await req(env.app, 'POST', '/notes', {
      title: '灵枢架构笔记',
      content_md: '# 灵枢\n\n灵枢是个人知识库 daemon。SQLite 事实库 + bge-m3 向量 + 混合召回。',
    })
    await req(env.app, 'POST', '/notes', {
      title: 'abc-reading-h5 构建要点',
      content_md: 'rsbuild 多入口配置，error-code-404 排查记录。',
    })
    await req(env.app, 'POST', '/notes', {
      title: '知音楼运维',
      content_md: 'CDP 直连客户端调试，window.nim 消息自动化。',
    })
  })

  test('中文长词 FTS 命中', async () => {
    const { json } = await req(env.app, 'GET', '/search?q=知识库')
    expect(json.length).toBeGreaterThan(0)
    expect(json[0].title).toBe('灵枢架构笔记')
  })

  test('2 字短词 LIKE 兜底', async () => {
    const { json } = await req(env.app, 'GET', '/search?q=灵枢')
    expect(json.length).toBeGreaterThan(0)
  })

  test('英文单词命中', async () => {
    const { json } = await req(env.app, 'GET', '/search?q=rsbuild')
    expect(json[0].title).toBe('abc-reading-h5 构建要点')
  })

  test('带连字符的标识符（LIKE 原始串兜底）', async () => {
    // trigram 不索引连字符，FTS 短语匹配会 miss，LIKE 用原始串兜底命中
    const { json } = await req(env.app, 'GET', '/search?q=error-code-404')
    expect(json.length).toBe(1)
    expect(json[0].title).toBe('abc-reading-h5 构建要点')
  })

  test('% 通配符按字面处理（不放大结果集）', async () => {
    const { json } = await req(env.app, 'GET', '/search?q=%25%25')
    expect(json.length).toBe(0)
  })

  test('_ 通配符按字面处理', async () => {
    // 搜「灵枢_」不应命中「灵枢」（如果 _ 被当单字通配符会命中）
    const { json } = await req(env.app, 'GET', '/search?q=灵枢_')
    expect(json.length).toBe(0)
  })

  test('空查询返回空数组', async () => {
    const { json } = await req(env.app, 'GET', '/search?q=')
    expect(json).toEqual([])
  })

  test('SQL 注入串无害化', async () => {
    const { status, json } = await req(env.app, 'GET', '/search?q=' + encodeURIComponent('"; DROP TABLE notes;--'))
    expect(status).toBe(200)
    // 库还在
    expect((await req(env.app, 'GET', '/status')).json.ok).toBe(true)
  })

  test('软删笔记不出现在搜索结果', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: '待删搜索', content_md: '独特关键词蔷薇风暴' })
    await req(env.app, 'DELETE', `/notes/${json.id}`)
    const hits = await req(env.app, 'GET', '/search?q=蔷薇风暴')
    expect(hits.json.length).toBe(0)
  })
})

describe('混合召回', () => {
  beforeEach(async () => {
    await req(env.app, 'POST', '/notes', {
      title: '知音楼消息处理',
      content_md: '通过 CDP 连接知音楼客户端，调用 window.nim 发送消息，支持群聊和私聊。',
    })
    await req(env.app, 'POST', '/notes', {
      title: '前端构建优化',
      content_md: 'rsbuild 构建提速，chunk 拆分与 tree-shaking 配置要点。',
    })
    // 消化脏队列，让向量就位
    await env.pipeline.processBatch(64)
  })

  test('召回返回结构完整', async () => {
    const { status, json } = await req(env.app, 'POST', '/recall', { query: '怎么发知音楼消息', k: 2 })
    expect(status).toBe(200)
    expect(json.length).toBeGreaterThan(0)
    const h = json[0]
    expect(h).toHaveProperty('id')
    expect(h).toHaveProperty('title')
    expect(h).toHaveProperty('score')
    expect(h).toHaveProperty('vec_score')
    expect(h).toHaveProperty('snippet')
  })

  test('空 query 返回空', async () => {
    const { json } = await req(env.app, 'POST', '/recall', { query: '' })
    expect(json).toEqual([])
  })

  test('FTS 命中路径融合（精确词召回）', async () => {
    const { json } = await req(env.app, 'POST', '/recall', { query: 'rsbuild 构建提速', k: 3 })
    expect(json[0].title).toBe('前端构建优化')
    expect(json[0].fts_rank).toBeGreaterThan(0)
  })

  test('k 参数生效', async () => {
    const { json } = await req(env.app, 'POST', '/recall', { query: '构建', k: 1 })
    expect(json.length).toBeLessThanOrEqual(1)
  })
})
