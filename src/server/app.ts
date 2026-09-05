// app.ts — Hono REST 应用（挂到 daemon）
// 所有路由只依赖注入的 { repo, recall, pipeline }，便于测试

import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { Repo, ConflictError, NotFoundError } from '../db/repo.ts'
import { RecallService } from '../recall/recall.ts'
import { EmbedPipeline } from '../embed/pipeline.ts'
import { Embedder } from '../embed/embedder.ts'

export interface AppDeps {
  repo: Repo
  recall: RecallService
  pipeline: EmbedPipeline
  backup: () => string
  /** 向量化是否就绪（有 API key）；未传时视为就绪（测试环境用 FakeEmbedder） */
  embedderReady?: boolean
}

export function createApp(deps: AppDeps): Hono {
  const { repo, recall, pipeline } = deps
  const embedderReady = deps.embedderReady ?? true
  const app = new Hono()

  // actor 从 header 或 query 取，默认 human；MCP/CLI 会带上自己的身份
  const actorOf = (c: any): string => c.req.header('x-actor') || c.req.query('actor') || 'human'
  // 数值参数安全解析：非法值（NaN/Infinity/负数）回落默认值，防止 SQL 绑定 500
  const numOr = (raw: string | undefined, dflt: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    const n = Number(raw)
    if (!Number.isFinite(n)) return dflt
    return Math.min(Math.max(Math.trunc(n), min), max)
  }

  app.onError((err, c) => {
    if (err instanceof ConflictError) return c.json({ error: 'conflict', expected: err.expectedVersion, actual: err.actualVersion }, 409)
    if (err instanceof NotFoundError) return c.json({ error: 'not_found', id: err.message }, 404)
    // JSON 解析失败 → 400（非法 body 不该算服务端错误）
    if (err instanceof SyntaxError) return c.json({ error: 'bad_request', message: '请求体不是合法 JSON' }, 400)
    console.error('[lingshu] 未处理错误:', err)
    return c.json({ error: 'internal', message: (err as Error).message }, 500)
  })

  // ── 健康与状态 ──
  app.get('/status', (c) =>
    c.json({ ok: true, ...repo.stats(), embedding_ready: embedderReady, pipeline_busy: pipeline.busy }),
  )

  // ── CRUD ──
  app.post('/notes', async (c) => {
    const body = await c.req.json<{ title: string; content_md: string; tags?: string[] }>()
    if (!body.title || typeof body.content_md !== 'string') {
      return c.json({ error: 'bad_request', message: 'title 和 content_md 必填' }, 400)
    }
    const note = repo.create({ title: body.title, content_md: body.content_md, tags: body.tags, actor: actorOf(c) })
    return c.json(note, 201)
  })

  app.get('/notes/:id', (c) => {
    // 先按 id 精确查，查不到再按标题模糊查（MCP/CLI 传标题的便利路径）
    const note = repo.get(c.req.param('id'), c.req.query('deleted') === '1') ?? repo.resolve(c.req.param('id'))
    if (!note) return c.json({ error: 'not_found' }, 404)
    return c.json({ ...note, tags: repo.getTags(note.id) })
  })

  app.put('/notes/:id', async (c) => {
    const body = await c.req.json<{ title?: string; content_md?: string; tags?: string[]; version?: number }>()
    const note = repo.update(c.req.param('id'), { ...body, expectedVersion: body.version, actor: actorOf(c) })
    return c.json({ ...note, tags: repo.getTags(note.id) })
  })

  app.delete('/notes/:id', (c) => {
    repo.delete(c.req.param('id'), actorOf(c))
    return c.json({ ok: true })
  })

  app.post('/notes/:id/restore', (c) => {
    const note = repo.restore(c.req.param('id'), actorOf(c))
    return c.json(note)
  })

  app.post('/notes/:id/rollback', async (c) => {
    const body = await c.req.json<{ version: number }>()
    const note = repo.rollback(c.req.param('id'), body.version, actorOf(c))
    return c.json(note)
  })

  app.get('/notes/:id/versions', (c) => c.json(repo.versions(c.req.param('id'))))

  // 版本内容预览（WebUI 版本历史弹窗用）
  app.get('/notes/:id/versions/:version', (c) => {
    const snap = repo.getVersionContent(c.req.param('id'), Number(c.req.param('version')))
    if (!snap) return c.json({ error: 'not_found' }, 404)
    return c.json(snap)
  })

  // ── 列表 / 搜索 / 召回 ──
  app.get('/notes', (c) =>
    c.json(repo.list({ tag: c.req.query('tag'), limit: numOr(c.req.query('limit'), 50, 1, 500), includeDeleted: c.req.query('deleted') === '1' })),
  )

  // 标签体系概览（Agent 选 tag 筛选前先看这个）
  app.get('/tags', (c) => c.json(repo.tagCloud()))

  // 回收站计数（左栏入口徽章）：直接 COUNT，不走 list 的 500 条截断
  app.get('/trash/count', (c) => c.json({ count: repo.trashCount() }))

  app.get('/search', (c) => c.json(repo.search(c.req.query('q') || '', numOr(c.req.query('limit'), 10, 1, 100))))

  app.post('/recall', async (c) => {
    const body = await c.req.json<{ query: string; k?: number }>()
    const hits = await recall.recall(body.query ?? '', body.k ?? 5)
    return c.json(
      hits.map((h) => ({
        id: h.note.id,
        title: h.note.title,
        score: Number(h.score.toFixed(4)),
        vec_score: Number(h.vec_score.toFixed(4)),
        fts_rank: h.fts_rank,
        tags: h.tags,
        snippet: h.snippet.slice(0, 150),
        updated_at: h.note.updated_at,
      })),
    )
  })

  // ── 事件流（多 Agent 感知）──
  app.get('/changes', (c) =>
    c.json(repo.changes(numOr(c.req.query('since'), 0, 0), numOr(c.req.query('limit'), 200, 1, 1000))))

  // ── 运维 ──
  app.post('/embed/drain', async (c) => {
    // 阻塞式清空脏队列（import 后调用）
    await pipeline.drainAll()
    return c.json({ ok: true, pending: repo.dirtyCount() })
  })

  app.post('/backup', (c) => c.json({ ok: true, path: deps.backup() }))

  // ── WebUI（静态单页，挂在根路径；API 路由优先匹配）──
  // 项目根目录绝对路径：从本文件（src/server/app.ts）上溯两级
  const webDir = new URL('../../', import.meta.url).pathname + 'web/'
  // no-cache：WebUI 迭代频繁（无构建哈希），让浏览器每次协商缓存，避免移动端拿到旧 JS
  app.get('/', async (c) => {
    const html = await Bun.file(webDir + 'index.html').text()
    return c.html(html, 200, { 'Cache-Control': 'no-cache' })
  })
  app.use('/*', serveStatic({ root: webDir }))

  return app
}
