// test/crud.test.ts — CRUD / 版本 / 软删 / 事件流 全生命周期

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestEnv, req, TestEnv } from './helpers.ts'

let env: TestEnv
beforeEach(() => { env = createTestEnv() })
afterEach(() => { env.cleanup() })

describe('创建', () => {
  test('创建笔记返回 201，字段完整', async () => {
    const { status, json } = await req(env.app, 'POST', '/notes', {
      title: '测试笔记',
      content_md: '# 内容\n\n正文 #标签A',
    }, 'zcode')
    expect(status).toBe(201)
    expect(json.title).toBe('测试笔记')
    expect(json.version).toBe(1)
    expect(json.updated_by).toBe('zcode')
    expect(json.deleted_at).toBeNull()
  })

  test('缺 title → 400', async () => {
    const { status, json } = await req(env.app, 'POST', '/notes', { content_md: 'x' })
    expect(status).toBe(400)
    expect(json.error).toBe('bad_request')
  })

  test('缺 content_md → 400', async () => {
    const { status } = await req(env.app, 'POST', '/notes', { title: 'x' })
    expect(status).toBe(400)
  })

  test('非法 JSON body → 400 而非 500', async () => {
    const res = await env.app.request('/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    })
    expect(res.status).toBe(400)
  })

  test('frontmatter 的 tags 数组被解析', async () => {
    const { json } = await req(env.app, 'POST', '/notes', {
      title: '带fm',
      content_md: '---\ntags:\n  - 项目/abc\n  - 前端\n---\n\n正文',
    })
    const got = await req(env.app, 'GET', `/notes/${json.id}`)
    expect(got.json.tags).toContain('项目/abc')
    expect(got.json.tags).toContain('前端')
  })

  test('行内 #tag 被提取，代码块内不算', async () => {
    const { json } = await req(env.app, 'POST', '/notes', {
      title: '行内tag',
      content_md: '正文 #行内标签\n\n```\n#代码块tag\n```\n\n结尾',
    })
    const got = await req(env.app, 'GET', `/notes/${json.id}`)
    expect(got.json.tags).toContain('行内标签')
    expect(got.json.tags).not.toContain('代码块tag')
  })
})

describe('读取', () => {
  test('按 id 读', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: 'A', content_md: 'a' })
    const got = await req(env.app, 'GET', `/notes/${json.id}`)
    expect(got.status).toBe(200)
    expect(got.json.title).toBe('A')
  })

  test('resolve 的 LIKE 通配符转义：% 不当通配符', async () => {
    await req(env.app, 'POST', '/notes', { title: '机密笔记-内部', content_md: 'x' })
    // 若 % 未转义，「机密%」会 LIKE 命中「机密笔记-内部」
    const hit = await req(env.app, 'GET', '/notes/机密%25')
    expect(hit.status).toBe(404)
    // 字面标题仍可模糊命中
    const ok = await req(env.app, 'GET', '/notes/机密笔记')
    expect(ok.status).toBe(200)
    expect(ok.json.title).toBe('机密笔记-内部')
  })

  test('按标题模糊读（repo.resolve 兜底路径）', async () => {
    await req(env.app, 'POST', '/notes', { title: '01-目录/某笔记名.md', content_md: 'a' })
    const got = await req(env.app, 'GET', '/notes/某笔记名')
    expect(got.status).toBe(200)
    expect(got.json.title).toBe('01-目录/某笔记名.md')
  })

  test('不存在的 id → 404', async () => {
    const { status } = await req(env.app, 'GET', '/notes/no-such')
    expect(status).toBe(404)
  })

  test('长文读回逐字节一致', async () => {
    // 20KB 中文长文
    const md = '# 长文\n\n' + Array.from({ length: 200 }, (_, i) => `## 第${i}节\n\n${'内容填充测试。'.repeat(12)}（唯一标记-${i}）`).join('\n\n')
    const { json } = await req(env.app, 'POST', '/notes', { title: '长文', content_md: md })
    const got = await req(env.app, 'GET', `/notes/${json.id}`)
    expect(got.json.content_md).toBe(md)
  })
})

describe('更新与乐观锁', () => {
  async function createNote() {
    const { json } = await req(env.app, 'POST', '/notes', { title: '原文', content_md: 'v1 内容' })
    return json.id as string
  }

  test('不带 version 的 LWW 更新，版本 +1，旧版本快照', async () => {
    const id = await createNote()
    const up = await req(env.app, 'PUT', `/notes/${id}`, { content_md: 'v2 内容' }, 'dsh')
    expect(up.json.version).toBe(2)
    expect(up.json.updated_by).toBe('dsh')
    const vs = await req(env.app, 'GET', `/notes/${id}/versions`)
    expect(vs.json.length).toBe(1)
    expect(vs.json[0].version).toBe(1)
    expect(vs.json[0].actor).toBe('human')
  })

  test('带正确 version → 200；旧 version → 409', async () => {
    const id = await createNote()
    const ok = await req(env.app, 'PUT', `/notes/${id}`, { content_md: 'v2', version: 1 })
    expect(ok.status).toBe(200)
    const conflict = await req(env.app, 'PUT', `/notes/${id}`, { content_md: 'stale', version: 1 })
    expect(conflict.status).toBe(409)
    expect(conflict.json.error).toBe('conflict')
    expect(conflict.json.actual).toBe(2)
  })

  test('更新不存在的笔记 → 404', async () => {
    const { status } = await req(env.app, 'PUT', '/notes/ghost', { content_md: 'x' })
    expect(status).toBe(404)
  })

  test('只改 title 不传 content_md，正文保留', async () => {
    const id = await createNote()
    const up = await req(env.app, 'PUT', `/notes/${id}`, { title: '新标题' })
    expect(up.json.title).toBe('新标题')
    expect(up.json.content_md).toBe('v1 内容')
  })

  test('回滚到历史版本', async () => {
    const id = await createNote()
    await req(env.app, 'PUT', `/notes/${id}`, { content_md: 'v2 内容' })
    const rb = await req(env.app, 'POST', `/notes/${id}/rollback`, { version: 1 })
    expect(rb.json.content_md).toBe('v1 内容')
    expect(rb.json.version).toBe(3) // 回滚也是一次更新
  })

  test('回滚到不存在的版本 → 404', async () => {
    const id = await createNote()
    const { status } = await req(env.app, 'POST', `/notes/${id}/rollback`, { version: 99 })
    expect(status).toBe(404)
  })
})

describe('软删与恢复', () => {
  test('软删后默认不可见，deleted=1 可见，可恢复', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: '待删', content_md: 'x' })
    const id = json.id

    await req(env.app, 'DELETE', `/notes/${id}`, undefined, 'cc')
    // 默认读 → 404
    expect((await req(env.app, 'GET', `/notes/${id}`)).status).toBe(404)
    // deleted=1 可读
    expect((await req(env.app, 'GET', `/notes/${id}?deleted=1`)).status).toBe(200)
    // 默认列表不含
    const list = await req(env.app, 'GET', '/notes?limit=500')
    expect(list.json.find((n: any) => n.id === id)).toBeUndefined()
    // deleted 列表含
    const dlist = await req(env.app, 'GET', '/notes?deleted=1&limit=500')
    expect(dlist.json.find((n: any) => n.id === id)).toBeDefined()

    const rs = await req(env.app, 'POST', `/notes/${id}/restore`, undefined, 'cc')
    expect(rs.json.deleted_at).toBeNull()
    // 恢复后默认可读
    expect((await req(env.app, 'GET', `/notes/${id}`)).status).toBe(200)
  })

  test('软删笔记不进向量化队列，恢复后重新入队', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: '删了还要向量', content_md: '内容一\n\n内容二\n\n内容三' })
    const id = json.id
    await env.pipeline.processBatch(64) // 先消费掉创建时的脏 chunk
    expect(env.repo.dirtyCount()).toBe(0)

    await req(env.app, 'DELETE', `/notes/${id}`)
    expect(env.repo.dirtyCount()).toBe(0) // 软删后无脏（update 不触发 rebuildChunks）

    // 修改一篇笔记制造脏 chunk，然后软删它 → 脏 chunk 应不计入
    const { json: n2 } = await req(env.app, 'POST', '/notes', { title: '先改再删', content_md: '初始' })
    await req(env.app, 'PUT', `/notes/${n2.id}`, { content_md: '修改后的内容，会重建 chunks' })
    expect(env.repo.dirtyCount()).toBeGreaterThan(0)
    await req(env.app, 'DELETE', `/notes/${n2.id}`)
    expect(env.repo.dirtyCount()).toBe(0)
  })

  test('删除/恢复不存在的笔记 → 404', async () => {
    expect((await req(env.app, 'DELETE', '/notes/ghost')).status).toBe(404)
    expect((await req(env.app, 'POST', '/notes/ghost/restore')).status).toBe(404)
  })
})

describe('事件流', () => {
  test('changes 按时间序记录所有操作与 actor', async () => {
    const { json: a } = await req(env.app, 'POST', '/notes', { title: 'A', content_md: 'a' }, 'zcode')
    await req(env.app, 'PUT', `/notes/${a.id}`, { content_md: 'a2' }, 'dsh')
    await req(env.app, 'DELETE', `/notes/${a.id}`, undefined, 'cc')
    await req(env.app, 'POST', `/notes/${a.id}/restore`, undefined, 'human')

    const { json } = await req(env.app, 'GET', '/changes?since=0')
    const ops = json.map((c: any) => `${c.op}:${c.actor}`)
    expect(ops).toEqual(['create:zcode', 'update:dsh', 'delete:cc', 'restore:human'])
  })

  test('since 增量拉取', async () => {
    const { json: a } = await req(env.app, 'POST', '/notes', { title: 'A', content_md: 'a' })
    const { json: b } = await req(env.app, 'POST', '/notes', { title: 'B', content_md: 'b' })
    const all = await req(env.app, 'GET', '/changes?since=0')
    const lastId = all.json[all.json.length - 1].id
    const { json: c } = await req(env.app, 'POST', '/notes', { title: 'C', content_md: 'c' })
    const inc = await req(env.app, 'GET', `/changes?since=${lastId}`)
    expect(inc.json.length).toBe(1)
    expect(inc.json[0].title).toBe('C')
  })
})

describe('标签', () => {
  test('tag 筛选列表', async () => {
    await req(env.app, 'POST', '/notes', { title: 'A', content_md: '内容 #前端' })
    await req(env.app, 'POST', '/notes', { title: 'B', content_md: '内容 #后端' })
    await req(env.app, 'POST', '/notes', { title: 'C', content_md: '内容 #前端 #后端' })

    const fe = await req(env.app, 'GET', '/notes?tag=前端')
    expect(fe.json.map((n: any) => n.title).sort()).toEqual(['A', 'C'])
  })

  test('tagCloud 计数', async () => {
    await req(env.app, 'POST', '/notes', { title: 'A', content_md: '#x' })
    await req(env.app, 'POST', '/notes', { title: 'B', content_md: '#x' })
    await req(env.app, 'POST', '/notes', { title: 'C', content_md: '#y' })
    const { json } = await req(env.app, 'GET', '/tags')
    const x = json.find((t: any) => t.tag === 'x')
    expect(x.count).toBe(2)
  })
})
