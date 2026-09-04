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
    description: '按 id 或标题读取笔记全文（markdown）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '笔记 id 或标题' } }, required: ['id'] },
    handler: (a) => api('GET', `/notes/${encodeURIComponent(a.id)}`),
  },
  {
    name: 'lingshu_write',
    description: '写入笔记：无 id 则创建，有 id 则更新。content_md 必须是完整 markdown（整体重写，不做增量拼接）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '笔记 id（留空创建新笔记）' },
        title: { type: 'string', description: '标题（创建时必填）' },
        content_md: { type: 'string', description: '完整 markdown 正文' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
        version: { type: 'number', description: '乐观锁：期望的当前版本号，不匹配返回 409。省略则 last-write-wins 覆盖' },
      },
      required: ['content_md'],
    },
    handler: (a) =>
      a.id
        ? api('PUT', `/notes/${encodeURIComponent(a.id)}`, { title: a.title, content_md: a.content_md, tags: a.tags, version: a.version })
        : api('POST', '/notes', { title: a.title || '未命名', content_md: a.content_md, tags: a.tags }),
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
