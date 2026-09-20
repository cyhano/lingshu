import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestEnv, req, TestEnv } from './helpers.ts'

let env: TestEnv
beforeEach(() => { env = createTestEnv() })
afterEach(() => { env.cleanup() })

const FM_CONTENT = `---
tags:
  - 工具/tck
created: 2026-08-31
---

TCK 容器平台的 CLI 是 \`tck\`。

## 部署要点（经验教训）

1. 直接执行即可

## 环境与分支严格对应（2026-09-17 用户明确立规）

**DEV 环境必须用 dev 分支构建**

- dev 环境（app-id 2824422）→ \`--branch dev\`
- prod 环境（app-id 2824701）→ \`--branch master\`

## 构建触发防重复（2026-09-20 实训）

**现象**

- 现象：重复触发
`

describe('replace_section 带 frontmatter 回归', () => {
  test('替换中间章节：其余章节完整保留，无重复标题', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: 't', content_md: FM_CONTENT }, 'zcode')
    const id = json.id as string
    // content 不带标题（方向 A：标题沿用 anchor）
    const r = await req(env.app, 'PATCH', `/notes/${id}`, {
      op: 'replace_section',
      anchor: '## 环境与分支严格对应（2026-09-17 用户明确立规）',
      content_md: '**DEV 必须用 dev**\n\n- dev → dev 分支\n- prod → master 分支\n',
    }, 'dsh')
    expect(r.status).toBe(200)
    const md = r.json.content_md
    // 标题只出现一次
    expect(md.split('## 环境与分支严格对应（2026-09-17 用户明确立规）').length - 1).toBe(1)
    // 新内容生效
    expect(md).toContain('**DEV 必须用 dev**')
    expect(md).toContain('- prod → master 分支')
    // 旧内容清除
    expect(md).not.toContain('- prod 环境（app-id 2824701）')
    // 前置章节保留
    expect(md).toContain('## 部署要点（经验教训）')
    expect(md).toContain('1. 直接执行即可')
    // 后置章节保留
    expect(md).toContain('## 构建触发防重复（2026-09-20 实训）')
    expect(md).toContain('- 现象：重复触发')
    // frontmatter 保留
    expect(md.startsWith('---\ntags:\n  - 工具/tck\ncreated: 2026-08-31\n---')).toBe(true)
  })

  test('content 误带同名标题：自动剥离，不产生重复标题', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: 't', content_md: FM_CONTENT }, 'zcode')
    const id = json.id as string
    const r = await req(env.app, 'PATCH', `/notes/${id}`, {
      op: 'replace_section',
      anchor: '## 环境与分支严格对应（2026-09-17 用户明确立规）',
      content_md: '## 环境与分支严格对应（2026-09-17 用户明确立规）\n\n**DEV 必须用 dev**\n',
    }, 'dsh')
    expect(r.status).toBe(200)
    const md = r.json.content_md
    expect(md.split('## 环境与分支严格对应（2026-09-17 用户明确立规）').length - 1).toBe(1)
    expect(md).toContain('**DEV 必须用 dev**')
    expect(md).toContain('## 构建触发防重复（2026-09-20 实训）')
  })

  test('anchor 省略 # 前缀：section 边界正确，不吞后续章节', async () => {
    const { json } = await req(env.app, 'POST', '/notes', { title: 't', content_md: FM_CONTENT }, 'zcode')
    const id = json.id as string
    const r = await req(env.app, 'PATCH', `/notes/${id}`, {
      op: 'replace_section',
      anchor: '环境与分支严格对应（2026-09-17 用户明确立规）',
      content_md: '改掉了。\n',
    }, 'dsh')
    expect(r.status).toBe(200)
    const md = r.json.content_md
    expect(md).toContain('改掉了。')
    expect(md).not.toContain('- dev 环境（app-id 2824422）')
    // 后续章节必须保留（这是省略 # 前缀时的历史 bug）
    expect(md).toContain('## 构建触发防重复（2026-09-20 实训）')
    expect(md).toContain('- 现象：重复触发')
  })
})
