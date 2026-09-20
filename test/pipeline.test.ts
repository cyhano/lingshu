// test/pipeline.test.ts — 切块策略 / 脏队列 / 向量化状态机 / 软删过滤

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestEnv, req, TestEnv } from './helpers.ts'
import { extractTags, splitFrontmatter } from '../src/db/repo.ts'

let env: TestEnv
beforeEach(() => { env = createTestEnv() })
afterEach(() => { env.cleanup() })

describe('frontmatter 解析（纯函数）', () => {
  test('YAML 列表 tags', () => {
    const md = '---\ntags:\n  - 项目/abc\n  - 前端\ncreated: 2026-09-01\n---\n\n正文'
    expect(extractTags(md).sort()).toEqual(['前端', '项目/abc'])
    expect(splitFrontmatter(md).frontmatter.tags).toEqual(['项目/abc', '前端'])
    expect(splitFrontmatter(md).frontmatter.created).toBe('2026-09-01')
  })

  test('行内数组 tags: [a, b]', () => {
    const md = '---\ntags: [x, y]\n---\n\n正文'
    expect(extractTags(md).sort()).toEqual(['x', 'y'])
  })

  test('无 frontmatter', () => {
    expect(extractTags('# 纯正文 #tag1')).toEqual(['tag1'])
    expect(splitFrontmatter('纯正文').frontmatter).toEqual({})
  })

  test('frontmatter 与正文 tag 合并去重', () => {
    const md = '---\ntags:\n  - dup\n---\n\n正文 #dup #另一个'
    const tags = extractTags(md).sort()
    expect(tags).toEqual(['dup', '另一个'])
  })

  test('嵌套层级标签（a/b/c）', () => {
    const md = '---\ntags:\n  - 工具/zcode/sub\n---\n\nx'
    expect(extractTags(md)).toEqual(['工具/zcode/sub'])
  })

  test('代码围栏内的 # 不算 tag（含 ~~~ 围栏）', () => {
    const md = '正文\n\n```\n#code1\n```\n\n~~~\n#code2\n~~~\n\n#真tag'
    expect(extractTags(md)).toEqual(['真tag'])
  })

  test('标题行不是 tag（# 标题语法排除）', () => {
    // # 后必须紧跟非空格才是 tag；markdown 标题 "# 标题" 不应误判
    expect(extractTags('# 这是一级标题\n\n## 二级')).toEqual([])
  })

  test('纯数字/编号引用不是 tag（issue/MR 编号）', () => {
    // GitHub issue 引用、MR 编号常以 # 开头，不应误提取
    const md = '发布了 MR #1245 承接测试，issue #416/#426 已确认，关联 #498。真 tag：#前端'
    const tags = extractTags(md)
    expect(tags).toEqual(['前端'])
    expect(tags).not.toContain('1245')
    expect(tags).not.toContain('416')
  })
})

describe('切块策略', () => {
  test('标题行单独成块，正文块不含标题行', async () => {
    const { json } = await req(env.app, 'POST', '/notes', {
      title: '切块',
      content_md: '# 主标题\n\n段落一。\n\n## 二级标题\n\n段落二。',
    })
    const chunks = (env.repo as any).db
      .query('SELECT seq, heading_path, content FROM chunks WHERE note_id = ? ORDER BY seq')
      .all(json.id) as Array<{ seq: number; heading_path: string; content: string }>
    // 两个标题块 + 「段落一。段落二。」聚合为 1 块（400 内合并是设计行为）= 3 块
    expect(chunks.length).toBe(3)
    const headings = chunks.filter((c) => c.content.startsWith('# '))
    expect(headings.map((h) => h.content)).toEqual(['# 主标题', '# 二级标题'])
    // 正文块不能混入标题行（此前 bug：标题重复出现在正文块里）
    const bodyChunks = chunks.filter((c) => !c.content.startsWith('# '))
    expect(bodyChunks.map((b) => b.content)).toEqual(['段落一。\n段落二。'])
    // 聚合块的 heading 取首段所属标题（「段落一」在主标题下）
    expect(bodyChunks[0].heading_path).toBe('主标题')
  })

  test('代码围栏内的 # 行不是标题（bash 注释不污染切块）', async () => {
    const { json } = await req(env.app, 'POST', '/notes', {
      title: '含代码块',
      content_md: '# 真标题\n\n正文。\n\n```bash\n# 这是注释不是标题\nls -la\n```\n\n结尾。',
    })
    const chunks = (env.repo as any).db
      .query('SELECT content, heading_path FROM chunks WHERE note_id = ? ORDER BY seq')
      .all(json.id) as Array<{ content: string; heading_path: string }>
    // 注释行不能单独成标题块
    expect(chunks.some((c) => c.content === '# 这是注释不是标题')).toBe(false)
    // 所有块的 heading 都应是「真标题」
    expect(chunks.every((c) => c.heading_path === '真标题')).toBe(true)
    // 代码块留在正文里
    const body = chunks.find((c) => !c.content.startsWith('# '))
    expect(body?.content).toContain('```bash')
  })

  test('frontmatter 不进 chunk', async () => {
    const { json } = await req(env.app, 'POST', '/notes', {
      title: 'fm排除',
      content_md: '---\ntags:\n  - t\n---\n\n正文内容',
    })
    const chunks = (env.repo as any).db
      .query('SELECT content FROM chunks WHERE note_id = ?')
      .all(json.id) as Array<{ content: string }>
    expect(chunks.every((c) => !c.content.includes('tags'))).toBe(true)
  })

  test('长段落按 400 字符聚合切段', async () => {
    // 10 段每段 ~180 字：聚合后应切成多块（每块 <=400）
    const long = Array.from({ length: 10 }, (_, i) => `段落${i} ${'内容填充。'.repeat(35)}`).join('\n\n')
    const { json } = await req(env.app, 'POST', '/notes', { title: '长段', content_md: long })
    const chunks = (env.repo as any).db
      .query('SELECT content FROM chunks WHERE note_id = ?')
      .all(json.id) as Array<{ content: string }>
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.every((c) => c.content.length <= 410)).toBe(true)
  })

  test('短段落聚合为一块是设计行为（400 内合并）', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: '短段', content_md: '段落一\n\n段落二\n\n段落三' })
    const chunks = (env.repo as any).db
      .query('SELECT content FROM chunks WHERE note_id = ?')
      .all(json.id) as Array<{ content: string }>
    expect(chunks.length).toBe(1)
    expect(chunks[0].content).toBe('段落一\n段落二\n段落三')
  })

  test('更新内容后旧 chunk 清除重建', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: '重建', content_md: '旧内容一\n\n旧内容二' })
    const before = (env.repo as any).db.query('SELECT COUNT(*) c FROM chunks WHERE note_id = ?').get(json.id)
    await req(env.app, 'PUT', `/notes/${json.id}`, { content_md: '新内容只有一段' })
    const after = (env.repo as any).db
      .query('SELECT content FROM chunks WHERE note_id = ?')
      .all(json.id) as Array<{ content: string }>
    expect(after.length).toBe(1)
    expect(after[0].content).toBe('新内容只有一段')
  })
})

describe('脏队列状态机', () => {
  test('创建即入队，processBatch 消费后清零', async () => {
    expect(env.repo.dirtyCount()).toBe(0)
    // 多段短文会聚合为 1 块（400 内合并是设计行为）；用标题+长内容确保多块
    const md = '# 标题\n\n' + Array.from({ length: 4 }, (_, i) => `段${i} ${'内容填充。'.repeat(40)}`).join('\n\n')
    await req(env.app, 'POST', '/notes', { title: 'A', content_md: md })
    expect(env.repo.dirtyCount()).toBeGreaterThanOrEqual(2) // 1 标题块 + >=1 正文块

    await env.pipeline.processBatch(64)
    expect(env.repo.dirtyCount()).toBe(0)

    // 向量真实写入（v2 起为 BLOB，字节数 = 维度 × 4）
    const emb = (env.repo as any).db.query('SELECT embedding FROM chunks LIMIT 1').get() as { embedding: Uint8Array }
    expect(emb.embedding).not.toBeNull()
    expect(emb.embedding.byteLength).toBe(64 * 4) // FakeEmbedder 64 维 → 256 字节
  })

  test('内容不变的重写不触发重建（hash 判重）', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: 'A', content_md: '稳定内容' })
    await env.pipeline.processBatch(64)
    // 只改 title 不动 content_md → 不重建 chunks
    await req(env.app, 'PUT', `/notes/${json.id}`, { title: '新标题' })
    expect(env.repo.dirtyCount()).toBe(0)
  })

  test('软删笔记的脏 chunk 不计入（修复回归）', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: '先改再删', content_md: '初始内容' })
    await env.pipeline.processBatch(64)
    await req(env.app, 'PUT', `/notes/${json.id}`, { content_md: '改后的内容会重建脏块' })
    expect(env.repo.dirtyCount()).toBeGreaterThan(0)
    await req(env.app, 'DELETE', `/notes/${json.id}`)
    expect(env.repo.dirtyCount()).toBe(0)
  })

  test('软删笔记的已向量化 chunk 不参与召回', async () => {
    const { json } = await req(env.app, 'POST', '/notes', {
      title: '召回排除',
      content_md: '独特词汇独角兽彩虹桥，用于验证删除后召回排除。',
    })
    await env.pipeline.processBatch(64)
    // 删除前可召回
    const before = await env.recall.recall('独角兽彩虹桥', 5)
    expect(before.length).toBe(1)

    await req(env.app, 'DELETE', `/notes/${json.id}`)
    const after = await env.recall.recall('独角兽彩虹桥', 5)
    expect(after.length).toBe(0)
  })
})
