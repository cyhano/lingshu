// test/patch.test.ts — 增量写（patch）：append / insert_before / replace_section
// 核心价值：局部写不需要重发全文，降低长笔记「整体重写」的丢内容风险

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestEnv, req, TestEnv } from './helpers.ts'

let env: TestEnv
beforeEach(() => { env = createTestEnv() })
afterEach(() => { env.cleanup() })

const SAMPLE = `# 标题

## 已知坑

坑一：a 会被误判。

坑二：b 会 500。

## 优化点

可以加缓存。

## 附录

一些尾巴。`

async function createSample(): Promise<string> {
  const { json } = await req(env.app, 'POST', '/notes', { title: '样本', content_md: SAMPLE }, 'zcode')
  return json.id as string
}

describe('append', () => {
  test('无 anchor：追加到文末', async () => {
    const id = await createSample()
    const r = await req(env.app, 'PATCH', `/notes/${id}`, { op: 'append', content_md: '追加的一段' }, 'dsh')
    expect(r.status).toBe(200)
    expect(r.json.content_md.endsWith('## 附录\n\n一些尾巴。\n\n追加的一段')).toBe(true)
    expect(r.json.version).toBe(2)
    expect(r.json.updated_by).toBe('dsh')
  })

  test('带 anchor：追加到该章节末尾（下一个标题之前）', async () => {
    const id = await createSample()
    const r = await req(env.app, 'PATCH', `/notes/${id}`, { op: 'append', content_md: '坑三：新坑', anchor: '## 已知坑' })
    expect(r.status).toBe(200)
    // 「坑三」应落在「## 优化点」之前，而非文末
    const md = r.json.content_md
    expect(md.indexOf('坑三：新坑')).toBeGreaterThan(md.indexOf('坑二'))
    expect(md.indexOf('坑三：新坑')).toBeLessThan(md.indexOf('## 优化点'))
  })

  test('frontmatter 保留，正文追加', async () => {
    const { json } = await req(env.app, 'POST', '/notes', {
      title: '带fm',
      content_md: '---\ntags:\n  - 前端\n---\n\n# 正文\n\n一句话。',
    })
    const r = await req(env.app, 'PATCH', `/notes/${json.id}`, { op: 'append', content_md: '补一句。' })
    expect(r.status).toBe(200)
    expect(r.json.content_md.startsWith('---\ntags:\n  - 前端\n---')).toBe(true)
    expect(r.json.content_md.endsWith('一句话。\n\n补一句。')).toBe(true)
    // frontmatter 标签仍被提取
    expect(r.json.tags).toContain('前端')
  })
})

describe('insert_before', () => {
  test('在锚点标题前插入', async () => {
    const id = await createSample()
    const r = await req(env.app, 'PATCH', `/notes/${id}`, { op: 'insert_before', content_md: '## 新章节\n\n新内容。', anchor: '## 优化点' })
    expect(r.status).toBe(200)
    const md = r.json.content_md
    expect(md.indexOf('## 新章节')).toBeGreaterThan(md.indexOf('## 已知坑'))
    expect(md.indexOf('## 新章节')).toBeLessThan(md.indexOf('## 优化点'))
  })

  test('缺 anchor → 400', async () => {
    const id = await createSample()
    const r = await req(env.app, 'PATCH', `/notes/${id}`, { op: 'insert_before', content_md: 'x' })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe('bad_request')
  })
})

describe('replace_section', () => {
  test('替换某标题整个章节，其余章节不动', async () => {
    const id = await createSample()
    const r = await req(env.app, 'PATCH', `/notes/${id}`, { op: 'replace_section', content_md: '## 已知坑\n\n（已全部修复）', anchor: '## 已知坑' })
    expect(r.status).toBe(200)
    const md = r.json.content_md
    expect(md).toContain('（已全部修复）')
    expect(md).not.toContain('坑一：a 会被误判')
    expect(md).not.toContain('坑二：b 会 500')
    // 其余章节保留
    expect(md).toContain('## 优化点')
    expect(md).toContain('可以加缓存')
    expect(md).toContain('## 附录')
    expect(md).toContain('一些尾巴')
    // 标题本身保留在开头
    expect(md.indexOf('# 标题')).toBe(0)
  })

  test('替换到最后一个章节：正确截到文末', async () => {
    const id = await createSample()
    const r = await req(env.app, 'PATCH', `/notes/${id}`, { op: 'replace_section', content_md: '## 附录\n\n新尾巴。', anchor: '## 附录' })
    expect(r.status).toBe(200)
    expect(r.json.content_md).toContain('新尾巴。')
    expect(r.json.content_md).not.toContain('一些尾巴。')
    expect(r.json.content_md).toContain('## 优化点')
  })
})

describe('锚点与冲突', () => {
  test('锚点标题不存在 → 404', async () => {
    const id = await createSample()
    const r = await req(env.app, 'PATCH', `/notes/${id}`, { op: 'replace_section', content_md: 'x', anchor: '## 不存在' })
    expect(r.status).toBe(404)
  })

  test('锚点可省略 # 前缀，取第一个同名标题', async () => {
    const id = await createSample()
    // 用「已知坑」而非「## 已知坑」也能定位
    const r = await req(env.app, 'PATCH', `/notes/${id}`, { op: 'replace_section', content_md: '## 已知坑\n\n替换了。', anchor: '已知坑' })
    expect(r.status).toBe(200)
    expect(r.json.content_md).toContain('替换了。')
    expect(r.json.content_md).not.toContain('坑一')
  })

  test('乐观锁：旧 version → 409，正文未被改动', async () => {
    const id = await createSample()
    // 先做一次更新把版本推到 2
    await req(env.app, 'PUT', `/notes/${id}`, { content_md: SAMPLE + '\n\n# 新节\n\n内容。' })
    const before = (await req(env.app, 'GET', `/notes/${id}`)).json.content_md
    const r = await req(env.app, 'PATCH', `/notes/${id}`, { op: 'append', content_md: '不该成功', version: 1 })
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('conflict')
    const after = (await req(env.app, 'GET', `/notes/${id}`)).json.content_md
    expect(after).toBe(before)
  })

  test('patch 也是一次 update：进入版本历史，可回滚', async () => {
    const id = await createSample()
    await req(env.app, 'PATCH', `/notes/${id}`, { op: 'append', content_md: '追加了。' })
    const vs = await req(env.app, 'GET', `/notes/${id}/versions`)
    expect(vs.json.length).toBe(1)
    expect(vs.json[0].version).toBe(1)
    const rb = await req(env.app, 'POST', `/notes/${id}/rollback`, { version: 1 })
    expect(rb.json.content_md).toBe(SAMPLE)
  })

  test('patch 不存在的笔记 → 404', async () => {
    const r = await req(env.app, 'PATCH', '/notes/ghost', { op: 'append', content_md: 'x' })
    expect(r.status).toBe(404)
  })
})

describe('边界', () => {
  test('非法 op → 400', async () => {
    const id = await createSample()
    const r = await req(env.app, 'PATCH', `/notes/${id}`, { op: 'delete_everything', content_md: 'x' })
    expect(r.status).toBe(400)
  })

  test('空正文笔记：append 直接落正文', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: '空', content_md: '' })
    const r = await req(env.app, 'PATCH', `/notes/${json.id}`, { op: 'append', content_md: '# 首个章节\n\n内容。' })
    expect(r.status).toBe(200)
    expect(r.json.content_md).toBe('# 首个章节\n\n内容。')
  })
})
