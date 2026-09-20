#!/usr/bin/env bun
// MCP stdio server — 灵枢的多 Agent 接入口
// ZCode / DSH / Claude Code 都走 MCP；本进程只是薄壳，所有操作转发到 daemon HTTP
// 身份通过环境变量 LINGSHU_ACTOR 注入（每个 Agent 的 MCP 配置里写死自己的身份）

export {} // 标记为 ES module（for await 顶层语法需要）

const BASE = process.env.LINGSHU_BASE || 'http://127.0.0.1:7430'
const ACTOR = process.env.LINGSHU_ACTOR || 'unknown-agent'

class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(`daemon HTTP ${status}`)
  }
}

async function api(method: string, pathName: string, body?: unknown): Promise<any> {
  const resp = await fetch(BASE + pathName, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-actor': ACTOR },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new ApiError(resp.status, json)
  return json
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: any) => Promise<unknown>
}

// read-before-write 基线：key → { version, title }（read 时快照）
// key 同时登记「内部 id」与「标题」两种形态，write/patch 无论传 id 还是标题都能命中。
// write 更新路径要求本会话 read 过目标笔记，且 read 之后版本未被他人改动。
const readBaseline = new Map<string, { version: number; title: string; id: string }>()

/** 记录 read 基线：同时登记 id 与标题两个 key，消除「read 用标题、write 用 id（或反之）」查不到基线的不一致 */
function recordBaseline(note: { id: string; title: string; version: number }): void {
  if (!note?.id) return
  const entry = { version: note.version, title: note.title, id: note.id }
  readBaseline.set(note.id, entry)
  readBaseline.set(note.title, entry)
}

const tools: ToolDef[] = [
  {
    name: 'lingshu_recall',
    description: '语义+关键词混合召回知识库笔记。每次需要引用既有知识/历史决策/项目背景时先调用本工具。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '自然语言问题' }, k: { type: 'number', description: '返回条数，默认 5' } },
      required: ['query'],
    },
    handler: (a) => api('POST', '/recall', { query: a.query, k: a.k ?? 5 }),
  },
  {
    name: 'lingshu_read',
    description: '按 id 或标题读取笔记全文（markdown）。写入（lingshu_write）前必须先 read 目标笔记；read 之后笔记被其他人改动过则 write 会被拒绝，需重新 read。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '笔记 id 或标题' } }, required: ['id'] },
    handler: async (a) => {
      const note = await api('GET', `/notes/${encodeURIComponent(a.id)}`)
      // 记录本次 read 的版本，作为后续 write 的基线（read-before-write + 变更检测）
      recordBaseline(note)
      return note
    },
  },
  {
    name: 'lingshu_write',
    description:
      '写入笔记：无 id 则创建，有 id 则更新。content_md 必须是完整 markdown（整体重写，不做增量拼接）。' +
      '**写前必须先 lingshu_read**：更新需先 read 过目标笔记（未 read 过直接拒绝）；read 之后笔记被他人改过（版本不匹配）也会拒绝，需重新 read 基于最新版改写。' +
      '创建时若已存在同题笔记会拒绝并返回已有笔记 id，应转为先 read 再更新（防止重复建篇，如一天多份日报）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '笔记 id（留空创建新笔记）' },
        title: { type: 'string', description: '标题（创建时必填）' },
        content_md: { type: 'string', description: '完整 markdown 正文' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
        version: { type: 'number', description: '乐观锁：期望的当前版本号，不匹配返回 409。省略则由 read 基线自动带上（推荐）' },
      },
      required: ['content_md'],
    },
    handler: async (a) => {
      // ── 更新路径：read-before-write + 变更检测 ──
      if (a.id) {
        const baseline = readBaseline.get(a.id)
        if (!baseline) {
          return { error: 'read_before_write', message: `笔记 ${a.id} 在本会话未 read 过，先调 lingshu_read 再写入（防止盲写覆盖他人改动）` }
        }
        // 变更检测：read 之后版本变了 → 说明有其他人改过，拒绝并要求重读
        const current = await api('GET', `/notes/${encodeURIComponent(a.id)}`).catch(() => null)
        if (!current) return { error: 'not_found', message: `笔记 ${a.id} 不存在（可能已被删除）` }
        if (current.version !== baseline.version) {
          return {
            error: 'stale_read',
            message: `笔记 ${a.id} 在 read 之后被 ${current.updated_by} 改过（read 时 v${baseline.version}，当前 v${current.version}）。请重新 lingshu_read 后基于最新版本改写`,
          }
        }
        // 用真实 id 做 PUT（a.id 可能是标题），乐观锁带 read 基线
        const result = await api('PUT', `/notes/${encodeURIComponent(current.id)}`, {
          title: a.title, content_md: a.content_md, tags: a.tags,
          version: a.version ?? baseline.version,
        })
        if (result?.id) recordBaseline(result) // 写成功后刷新基线
        return result
      }
      // ── 创建路径：同题查重，防重复建篇 ──
      const title = a.title || '未命名'
      const dup = await api('GET', `/notes/${encodeURIComponent(title)}`).catch(() => null)
      if (dup?.id) {
        return {
          error: 'duplicate_title',
          message: `已存在同题笔记「${dup.title}」（id: ${dup.id}，v${dup.version}，${dup.updated_at} 更新）。不要新建，先 lingshu_read 该笔记，然后把内容合并进去更新`,
        }
      }
      const created = await api('POST', '/notes', { title, content_md: a.content_md, tags: a.tags })
      if (created?.id) recordBaseline(created)
      return created
    },
  },
  {
    name: 'lingshu_patch',
    description:
      '增量写笔记：append（末尾追加）、insert_before（在标题前插入）、replace_section（替换某标题整个章节），' +
      '按 markdown 标题锚点定位，无需重发全文，降低长笔记「整体重写」的丢内容风险。' +
      '**写前必须先 lingshu_read**（与 lingshu_write 共用 read 基线，read 后被他人改过则拒绝）。' +
      'replace_section 的 content_md 不含标题（标题沿用 anchor 原样）；误带同名标题会自动剥离。' +
      '锚点找不到会报错，可回退用 lingshu_write 全文写。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '笔记 id' },
        op: { type: 'string', enum: ['append', 'insert_before', 'replace_section'], description: '操作类型' },
        content_md: { type: 'string', description: '要追加/插入/替换的 markdown 片段（片段，非全文）' },
        anchor: { type: 'string', description: '标题锚点，如「## 已知坑」；append 可省略，insert_before/replace_section 必填' },
        version: { type: 'number', description: '乐观锁版本号，省略则用 read 基线（推荐）' },
      },
      required: ['id', 'op', 'content_md'],
    },
    handler: async (a) => {
      // 复用 read-before-write 基线：必须先 read，且 read 后版本未被他人改动
      const baseline = readBaseline.get(a.id)
      if (!baseline) {
        return { error: 'read_before_write', message: `笔记 ${a.id} 在本会话未 read 过，先调 lingshu_read 再 patch` }
      }
      const current = await api('GET', `/notes/${encodeURIComponent(a.id)}`).catch(() => null)
      if (!current) return { error: 'not_found', message: `笔记 ${a.id} 不存在（可能已被删除）` }
      if (current.version !== baseline.version) {
        return {
          error: 'stale_read',
          message: `笔记 ${a.id} 在 read 之后被 ${current.updated_by} 改过（read 时 v${baseline.version}，当前 v${current.version}）。请重新 lingshu_read 后重试`,
        }
      }
      const result = await api('PATCH', `/notes/${encodeURIComponent(current.id)}`, {
        op: a.op,
        content_md: a.content_md,
        anchor: a.anchor,
        version: a.version ?? baseline.version,
      })
      if (result?.id) recordBaseline(result)
      return result
    },
  },
  {
    name: 'lingshu_search',
    description: 'FTS 关键词精确搜索（项目名、报错码等精确词用这个，比语义召回准）。',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } }, required: ['q'] },
    handler: (a) => api('GET', `/search?q=${encodeURIComponent(a.q)}&limit=${a.limit ?? 10}`),
  },
  {
    name: 'lingshu_changes',
    description: '拉取自 since 以来的变更事件流——其他 Agent 改了什么。session 开始时建议先拉一次增量。',
    inputSchema: { type: 'object', properties: { since: { type: 'number', description: '上次拉到的最大 id，默认 0' } } },
    handler: (a) => api('GET', `/changes?since=${a.since ?? 0}`),
  },
  {
    name: 'lingshu_delete',
    description: '删除笔记（软删除，进回收站，可通过 WebUI 回收站恢复）。按 id 或标题定位。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '笔记 id 或标题' } }, required: ['id'] },
    handler: (a) => api('DELETE', `/notes/${encodeURIComponent(a.id)}`),
  },
  {
    name: 'lingshu_feedback',
    description:
      '给一条召回结果打反馈：hit=这条笔记帮上了忙，miss=没用/答非所问。' +
      '用于沉淀召回质量信号，长期调优混合召回、识别「召回了但没用」的笔记。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '笔记 id 或标题' },
        query: { type: 'string', description: '本次召回对应的查询词（可选，留空也能记）' },
        verdict: { type: 'string', enum: ['hit', 'miss'], description: 'hit=帮上忙 / miss=没用' },
      },
      required: ['id', 'verdict'],
    },
    handler: (a) => api('POST', `/recall/${encodeURIComponent(a.id)}/feedback`, { query: a.query ?? '', verdict: a.verdict }),
  },
]

// ── stdio JSON-RPC 循环 ──
const STDIN = Bun.stdin.stream()
const decoder = new TextDecoder()
let buf = ''

for await (const chunk of STDIN) {
  buf += decoder.decode(chunk)
  let nl: number
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    handleRpc(line)
  }
}

async function handleRpc(line: string): Promise<void> {
  let req: any
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = req
  const reply = (result: unknown) => writeOut({ jsonrpc: '2.0', id, result })
  const replyErr = (code: number, message: string) => writeOut({ jsonrpc: '2.0', id, error: { code, message } })

  switch (method) {
    case 'initialize':
      reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'lingshu', version: '0.1.0' },
      })
      break
    case 'notifications/initialized':
      break
    case 'tools/list':
      reply({
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      })
      break
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params?.name)
      if (!tool) { replyErr(-32602, `未知工具: ${params?.name}`); break }
      try {
        const result = await tool.handler(params?.arguments ?? {})
        writeOut({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        })
      } catch (e) {
        // daemon 的 HTTP 错误（409 冲突/404 不存在等）结构化透传给 Agent，避免「写失败被当成功」
        if (e instanceof ApiError) {
          const hint = e.status === 409
            ? '（版本冲突：其他 Agent 刚改过这篇笔记。重读后基于最新版本重写，不带 version 参数则覆盖）'
            : e.status === 404 ? '（目标笔记不存在，检查 id 或标题）' : ''
          writeOut({
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'text', text: `daemon 返回 ${e.status} ${hint}\n${JSON.stringify(e.body)}` }],
              isError: true,
            },
          })
        } else {
          writeOut({
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: `执行失败: ${(e as Error).message}` }], isError: true },
          })
        }
      }
      break
    }
    case 'ping':
      reply({})
      break
    default:
      if (id !== undefined) replyErr(-32601, `未知方法: ${method}`)
  }
}

function writeOut(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
