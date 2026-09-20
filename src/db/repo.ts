// repo.ts — 灵枢 CRUD 仓库
// 所有 SQL 集中于此；daemon 是唯一调用方（串行化写），因此无需连接池
// 写策略：last-write-wins + versions 快照留底；PUT 传 version 则乐观锁校验

import { Database } from 'bun:sqlite'
import { randomUUID, createHash } from 'node:crypto'

export type Actor = string // 'zcode' | 'dsh' | 'cc' | 'human' | ...

export interface NoteRow {
  id: string
  title: string
  content_md: string
  content_hash: string
  frontmatter: string
  version: number
  updated_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface ChangeRow {
  id: number
  note_id: string
  op: string
  actor: string
  title: string
  ts: string
}

export class ConflictError extends Error {
  constructor(public expectedVersion: number, public actualVersion: number) {
    super(`版本冲突：期望 ${expectedVersion}，实际 ${actualVersion}`)
  }
}

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`笔记不存在：${id}`)
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function now(): string {
  return new Date().toISOString()
}

/** 从 markdown 提取标签：frontmatter 的 tags 数组 + 正文行内 #tag（排除代码块） */
export function extractTags(content: string): string[] {
  const tags = new Set<string>()
  // 1. frontmatter tags 列表（YAML 数组格式 "- xxx"，也兼容行内 "tags: [a, b]"）
  const fm = content.match(/^---\n([\s\S]*?)\n---/)
  if (fm) {
    const inline = fm[1].match(/^tags:\s*\[(.+)\]\s*$/m)
    if (inline) {
      for (const t of inline[1].split(',')) {
        const v = t.trim().replace(/^["']|["']$/g, '')
        if (v) tags.add(v)
      }
    } else {
      let inTags = false
      for (const line of fm[1].split('\n')) {
        if (/^tags:\s*$/.test(line)) { inTags = true; continue }
        if (inTags) {
          const item = line.match(/^\s+-\s+(.+)$/)
          if (item) {
            const v = item[1].trim().replace(/^["']|["']$/g, '')
            if (v) tags.add(v)
          } else {
            inTags = false // tags 列表结束（遇到下一个 key）
          }
        }
      }
    }
  }
  // 2. 正文行内 #tag；纯数字/数字形态不算（GitHub issue「#416/#426」、MR「#1245」等编号会被误吃）
  let inFence = false
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '')
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    for (const m of line.matchAll(/(?:^|[\s\u3000:：,，;；()（）\]\）])#([\w\u4e00-\u9fff][\w\u4e00-\u9fff/-]*)/g)) {
      const tag = m[1]
      if (/^[\d/-]+$/.test(tag)) continue // 纯数字/编号引用不是 tag
      tags.add(tag)
    }
  }
  return [...tags]
}

/** 剥离 frontmatter，返回 { body, frontmatterJson }（tags 数组解析为 string[]，其余标量） */
export function splitFrontmatter(content: string): { body: string; frontmatter: Record<string, unknown> } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { body: content, frontmatter: {} }
  const fm: Record<string, unknown> = {}
  let currentKey: string | null = null
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/)
    if (kv) {
      currentKey = kv[1]
      const val = kv[2].trim()
      if (val.startsWith('[') && val.endsWith(']')) {
        fm[kv[1]] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      } else {
        fm[kv[1]] = val.replace(/^["']|["']$/g, '')
      }
    } else if (currentKey) {
      const item = line.match(/^\s+-\s+(.+)$/)
      if (item) {
        const v = item[1].trim().replace(/^["']|["']$/g, '')
        const existing = fm[currentKey]
        if (Array.isArray(existing)) existing.push(v)
        else if (existing === '' || existing === undefined) fm[currentKey] = [v]
        else fm[currentKey] = [existing, v]
      }
    }
  }
  return { body: content.slice(m[0].length), frontmatter: fm }
}

export class Repo {
  constructor(private db: Database) {}

  // ── 读 ──

  get(id: string, includeDeleted = false): NoteRow | null {
    const row = this.db.query('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | null
    if (!row) return null
    if (row.deleted_at && !includeDeleted) return null
    return row
  }

  /** 按 id 或 title 模糊查找（MCP/CLI 便利接口）；LIKE 转义防 %/_ 通配符误命中 */
  resolve(idOrTitle: string): NoteRow | null {
    const byId = this.get(idOrTitle)
    if (byId) return byId
    const esc = idOrTitle.replace(/[\\%_]/g, (m) => '\\' + m)
    const row = this.db
      .query(`SELECT * FROM notes WHERE deleted_at IS NULL AND (title = ? OR title LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 1`)
      .get(idOrTitle, `%${esc}%`) as NoteRow | null
    return row
  }

  /**
   * 列表查询。
   * deleted: 'only' = 只返回已软删（回收站）；'all' = 含未删与已删；undefined = 默认只返回未删
   */
  list(opts: { tag?: string; limit?: number; deleted?: 'only' | 'all' } = {}): NoteRow[] {
    const limit = Math.min(opts.limit ?? 50, 500)
    // 三态过滤条件：only → 只看已删；all → 不过滤；默认 → 排除已删
    const filter =
      opts.deleted === 'only' ? 'WHERE deleted_at IS NOT NULL' :
      opts.deleted === 'all' ? '' :
      'WHERE deleted_at IS NULL'
    const tagFilter = opts.deleted === 'all' ? '' : opts.deleted === 'only' ? 'AND n.deleted_at IS NOT NULL' : 'AND n.deleted_at IS NULL'
    if (opts.tag) {
      return this.db
        .query(`SELECT n.* FROM notes n JOIN tags t ON t.note_id = n.id
                WHERE t.tag = ? ${tagFilter}
                ORDER BY n.updated_at DESC LIMIT ?`)
        .all(opts.tag, limit) as NoteRow[]
    }
    return this.db
      .query(`SELECT * FROM notes ${filter}
              ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as NoteRow[]
  }

  getTags(id: string): string[] {
    return (this.db.query('SELECT tag FROM tags WHERE note_id = ?').all(id) as { tag: string }[]).map((r) => r.tag)
  }

  /** FTS5 trigram 全文搜索（bm25 排序）；短查询词（<3 字符）降级 LIKE */
  /** FTS5 trigram 全文搜索（bm25 排序）；连字符会破坏短语匹配，LIKE 兜底用原始串 */
  search(query: string, limit = 10): NoteRow[] {
    const raw = query.trim()
    if (!raw) return []
    // FTS 路：连字符/引号替换为空格（trigram tokenizer 不索引它们，替换后做短语匹配）
    const q = raw.replace(/["'-]/g, ' ').replace(/\s+/g, ' ').trim()
    let rows: NoteRow[] = []
    if ([...q].length >= 3) {
      try {
        rows = this.db
          .query(`SELECT n.* FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
                  WHERE notes_fts MATCH ? AND n.deleted_at IS NULL
                  ORDER BY bm25(notes_fts) LIMIT ?`)
          .all(`"${q}"`, limit) as NoteRow[]
      } catch { /* MATCH 语法异常时走 LIKE */ }
    }
    if (rows.length === 0) {
      // 兜底：短词/未命中/特殊字符时 LIKE 模糊（个人库规模全表扫也毫秒级）
      // ESCAPE 处理 LIKE 通配符，保证用户输入的 % _ \ 按字面匹配
      const esc = raw.replace(/[\\%_]/g, (m) => '\\' + m)
      rows = this.db
        .query(`SELECT * FROM notes WHERE deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR content_md LIKE ? ESCAPE '\\')
                ORDER BY updated_at DESC LIMIT ?`)
        .all(`%${esc}%`, `%${esc}%`, limit) as NoteRow[]
    }
    return rows
  }

  changes(since = 0, limit = 200): ChangeRow[] {
    return this.db
      .query('SELECT * FROM changes WHERE id > ? ORDER BY id LIMIT ?')
      .all(since, limit) as ChangeRow[]
  }

  versions(id: string): Array<{ version: number; actor: string; ts: string; title: string }> {
    return this.db
      .query('SELECT version, actor, ts, title FROM versions WHERE note_id = ? ORDER BY version DESC')
      .all(id) as Array<{ version: number; actor: string; ts: string; title: string }>
  }

  getVersionContent(id: string, version: number): { title: string; content_md: string } | null {
    return (this.db
      .query('SELECT title, content_md FROM versions WHERE note_id = ? AND version = ?')
      .get(id, version)) as { title: string; content_md: string } | null
  }

  // ── 写 ──

  create(input: { title: string; content_md: string; tags?: string[]; actor: Actor }): NoteRow {
    const id = randomUUID().slice(0, 12)
    const ts = now()
    const { frontmatter } = splitFrontmatter(input.content_md)
    const tags = [...new Set([...(input.tags ?? []), ...extractTags(input.content_md)])]
    this.db.transaction(() => {
      this.db.query(
        `INSERT INTO notes (id, title, content_md, content_hash, frontmatter, version, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(id, input.title, input.content_md, sha256(input.content_md), JSON.stringify(frontmatter), input.actor, ts, ts)
      const stmt = this.db.query('INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)')
      for (const tag of tags) stmt.run(id, tag)
      this.db.query('INSERT INTO changes (note_id, op, actor, title, ts) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'create', input.actor, input.title, ts)
      this.rebuildChunks(id, input.content_md)
    })()
    return this.get(id)!
  }

  update(
    id: string,
    input: { title?: string; content_md?: string; tags?: string[]; actor: Actor; expectedVersion?: number },
  ): NoteRow {
    const old = this.get(id)
    if (!old) throw new NotFoundError(id)
    if (input.expectedVersion !== undefined && input.expectedVersion !== old.version) {
      throw new ConflictError(input.expectedVersion, old.version)
    }
    const title = input.title ?? old.title
    const content = input.content_md ?? old.content_md
    const contentChanged = content !== old.content_md
    const ts = now()
    const { frontmatter } = splitFrontmatter(content)
    const newVersion = old.version + 1

    this.db.transaction(() => {
      // 旧版本快照（留底，可回滚）
      this.db.query(
        'INSERT INTO versions (note_id, version, title, content_md, actor, ts) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, old.version, old.title, old.content_md, old.updated_by, old.updated_at)
      this.db.query(
        `UPDATE notes SET title = ?, content_md = ?, content_hash = ?, frontmatter = ?,
         version = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      ).run(title, content, sha256(content), JSON.stringify(frontmatter), newVersion, input.actor, ts, id)

      if (input.tags !== undefined || contentChanged) {
        this.db.query('DELETE FROM tags WHERE note_id = ?').run(id)
        const tags = [...new Set([...(input.tags ?? []), ...extractTags(content)])]
        const stmt = this.db.query('INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)')
        for (const tag of tags) stmt.run(id, tag)
      }
      this.db.query('INSERT INTO changes (note_id, op, actor, title, ts) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'update', input.actor, title, ts)
      if (contentChanged) this.rebuildChunks(id, content)
    })()
    return this.get(id)!
  }

  /** 软删（可恢复）；硬删用 purge */
  delete(id: string, actor: Actor): void {
    const row = this.get(id)
    if (!row) throw new NotFoundError(id)
    this.db.transaction(() => {
      this.db.query('UPDATE notes SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?')
        .run(now(), actor, now(), id)
      this.db.query('INSERT INTO changes (note_id, op, actor, title, ts) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'delete', actor, row.title, now())
    })()
  }

  restore(id: string, actor: Actor): NoteRow {
    const row = this.get(id, true)
    if (!row) throw new NotFoundError(id)
    if (!row.deleted_at) return row
    this.db.transaction(() => {
      this.db.query('UPDATE notes SET deleted_at = NULL, updated_by = ?, updated_at = ? WHERE id = ?')
        .run(actor, now(), id)
      this.db.query('INSERT INTO changes (note_id, op, actor, title, ts) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'restore', actor, row.title, now())
    })()
    return this.get(id)!
  }

  purge(id: string): void {
    // 硬删：清 FTS、tags、chunks（versions 保留作审计）
    const row = this.get(id, true)
    if (!row) throw new NotFoundError(id)
    this.db.transaction(() => {
      this.db.query('DELETE FROM notes WHERE id = ?').run(id) // 触发器同步清 FTS；FK 级联清 tags/chunks
    })()
  }

  /** 回滚到指定版本 */
  rollback(id: string, version: number, actor: Actor): NoteRow {
    const snap = this.getVersionContent(id, version)
    if (!snap) throw new NotFoundError(`版本 ${version} 不存在`)
    return this.update(id, { title: snap.title, content_md: snap.content_md, actor })
  }

  // ── 切块维护（供向量化 pipeline）──

  /** 重建某笔记的 chunks（embedding 置 NULL = 脏标记） */
  private rebuildChunks(id: string, content: string): void {
    const { body } = splitFrontmatter(content)
    const hash = sha256(content)
    const ts = now()
    this.db.query('DELETE FROM chunks WHERE note_id = ?').run(id)
    const stmt = this.db.query(
      'INSERT INTO chunks (note_id, seq, heading_path, content, embedding, content_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    let seq = 0
    let headingPath = ''

    // 第一遍：按空行/标题行切段落；标题行单独成块（保留结构导航），并记录每段所属的标题路径
    // 代码围栏内的 # 行不是标题（bash 注释等）
    const paragraphs: Array<{ text: string; heading: string }> = []
    let paraBuf: string[] = []
    let paraHeading = ''
    let inFence = false
    const flushPara = () => {
      const text = paraBuf.join('\n').trim()
      if (text) paragraphs.push({ text, heading: paraHeading })
      paraBuf = []
    }
    for (const line of body.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        paraBuf.push(line) // 围栏行保留在段落里
        continue
      }
      if (inFence) {
        paraBuf.push(line)
        continue
      }
      const h = line.match(/^(#{1,3})\s+(.*)/)
      if (h) {
        flushPara()
        headingPath = h[2].trim()
        paraHeading = headingPath
        stmt.run(id, seq++, headingPath, `# ${h[2].trim()}`, null, hash, ts)
      } else if (line.trim() === '') {
        flushPara() // 空行 = 段落边界
      } else {
        paraBuf.push(line)
      }
    }
    flushPara()

    // 第二遍：正文段落聚合切块（400 字符内）；块的 heading 取首段所属标题
    let buf = ''
    let bufHeading = ''
    for (const p of paragraphs) {
      if ((buf + '\n' + p.text).length > 400 && buf) {
        stmt.run(id, seq++, bufHeading, buf, null, hash, ts)
        buf = p.text
        bufHeading = p.heading
      } else {
        if (!buf) bufHeading = p.heading
        buf = buf ? buf + '\n' + p.text : p.text
      }
    }
    if (buf) stmt.run(id, seq++, bufHeading, buf, null, hash, ts)
  }

  /** 脏 chunk：embedding IS NULL */
  dirtyChunks(limit = 64): Array<{ id: number; content: string; heading_path: string }> {
    // JOIN notes 过滤软删：已删笔记不再浪费 embedding 调用（恢复后其 chunk 仍为脏，会自动补）
    return this.db
      .query(`SELECT c.id, c.content, c.heading_path FROM chunks c
              JOIN notes n ON n.id = c.note_id
              WHERE c.embedding IS NULL AND n.deleted_at IS NULL LIMIT ?`)
      .all(limit) as Array<{ id: number; content: string; heading_path: string }>
  }

  dirtyCount(): number {
    return (this.db
      .query(`SELECT COUNT(*) as c FROM chunks c JOIN notes n ON n.id = c.note_id
              WHERE c.embedding IS NULL AND n.deleted_at IS NULL`)
      .get() as { c: number }).c
  }

  writeEmbeddings(items: Array<{ id: number; embedding: number[] }>): void {
    const stmt = this.db.query('UPDATE chunks SET embedding = ? WHERE id = ?')
    const tx = this.db.transaction(() => {
      for (const it of items) stmt.run(JSON.stringify(it.embedding), it.id)
    })
    tx()
  }

  /** 全部已向量化的 chunk（暴力召回用） */
  allEmbeddedChunks(): Array<{ id: number; note_id: string; seq: number; heading_path: string; content: string; embedding: string }> {
    return this.db
      .query('SELECT id, note_id, seq, heading_path, content, embedding FROM chunks WHERE embedding IS NOT NULL')
      .all() as Array<{ id: number; note_id: string; seq: number; heading_path: string; content: string; embedding: string }>
  }

  notesByIds(ids: string[]): NoteRow[] {
    if (ids.length === 0) return []
    const ph = ids.map(() => '?').join(',')
    return this.db
      .query(`SELECT * FROM notes WHERE id IN (${ph}) AND deleted_at IS NULL`)
      .all(...ids) as NoteRow[]
  }

  /** 重刷全部笔记的 tags（extractTags 逻辑升级后补数据用） */
  reextractAllTags(): number {
    const rows = this.db.query('SELECT id, content_md FROM notes').all() as Array<{ id: string; content_md: string }>
    const tx = this.db.transaction(() => {
      const stmt = this.db.query('INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)')
      for (const row of rows) {
        for (const tag of extractTags(row.content_md)) stmt.run(row.id, tag)
      }
    })
    tx()
    return rows.length
  }

  /** 重切全部笔记的 chunks（切块逻辑升级后补数据用；旧向量作废重新排队） */
  rechunkAll(): number {
    const rows = this.db.query('SELECT id, content_md FROM notes WHERE deleted_at IS NULL').all() as Array<{ id: string; content_md: string }>
    const tx = this.db.transaction(() => {
      for (const row of rows) this.rebuildChunks(row.id, row.content_md)
    })
    tx()
    return rows.length
  }

  /** 列出全部标签及计数（tag 体系概览用） */
  tagCloud(): Array<{ tag: string; count: number }> {
    return this.db
      .query('SELECT tag, COUNT(*) as count FROM tags GROUP BY tag ORDER BY count DESC, tag')
      .all() as Array<{ tag: string; count: number }>
  }

  /** 回收站计数（无 500 条截断，专用于徽章） */
  trashCount(): number {
    return (this.db.query('SELECT COUNT(*) as c FROM notes WHERE deleted_at IS NOT NULL').get() as { c: number }).c
  }

  stats(): Record<string, number> {
    const one = (sql: string) => (this.db.query(sql).get() as { c: number }).c
    return {
      notes: one('SELECT COUNT(*) c FROM notes WHERE deleted_at IS NULL'),
      deleted: one('SELECT COUNT(*) c FROM notes WHERE deleted_at IS NOT NULL'),
      tags: one('SELECT COUNT(DISTINCT tag) c FROM tags'),
      chunks: one('SELECT COUNT(*) c FROM chunks'),
      // 与 dirtyCount 同口径：不计软删笔记的 chunk
      pending_embeddings: one(`SELECT COUNT(*) c FROM chunks c JOIN notes n ON n.id = c.note_id
        WHERE c.embedding IS NULL AND n.deleted_at IS NULL`),
      versions: one('SELECT COUNT(*) c FROM versions'),
      changes: one('SELECT COUNT(*) c FROM changes'),
    }
  }

  // ── 增量写（patch）：按标题锚点定位段落，做 append / insert_before / replace_section ──
  // 目的：给 Agent 一个低风险的局部写原语，避免「改一行也要整体重写全文」带来的隐性丢内容风险。
  // 定位复用笔记正文的 markdown 标题结构（与 rebuildChunks 的标题切分口径一致），
  // 不依赖 chunks 表（软删/未向量化的笔记也能 patch）。

  /** 按标题锚点定位正文中的 section 区间，返回 [startLine, endLine)（0-based，含行首偏移，不含换行结尾）。
   *  - anchor 匹配「去掉 # 前缀后 trim 相等」的标题行；同名标题取第一个匹配。
   *  - startLine 指向标题行本身；endLine 指向下一个同级或更高级标题行（不含），无则到文末。
   */
  private findSectionRange(bodyLines: string[], anchor: string): { start: number; end: number } | null {
    const target = anchor.trim().replace(/^#+\s*/, '')
    if (!target) return null
    const anchorLevel = (anchor.match(/^#+/) || [''])[0].length
    let start = -1
    let end = bodyLines.length
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i]
      const m = line.match(/^(#{1,6})\s+(.*)$/)
      if (!m) continue
      const level = m[1].length
      const text = m[2].trim()
      if (start < 0 && text === target) {
        start = i
      } else if (start >= 0 && level <= anchorLevel) {
        // 下一个同级或更高级标题 = section 结束边界
        end = i
        break
      }
    }
    return start < 0 ? null : { start, end }
  }

  /**
   * 增量写。三种模式：
   *  - append:           把 content_md 追加到笔记末尾（anchor 可省略；给 anchor 则追加到该 section 末尾）
   *  - insert_before:    在 anchor 标题之前插入 content_md（anchor 必填）
   *  - replace_section:  用 content_md 整体替换 anchor 标题那一整个 section（anchor 必填）
   * 所有模式都复用 update() 的版本快照与乐观锁，与全文写天然互斥、可回滚。
   */
  patch(
    id: string,
    input: { op: 'append' | 'insert_before' | 'replace_section'; content_md: string; anchor?: string; actor: Actor; expectedVersion?: number },
  ): NoteRow {
    const old = this.get(id)
    if (!old) throw new NotFoundError(id)
    const { body, frontmatter } = splitFrontmatter(old.content_md)
    // bodyLines：正文逐行（去掉末尾多余换行，便于行号稳定）
    const bodyText = body.replace(/\n+$/, '')
    const bodyLines = bodyText === '' ? [] : bodyText.split('\n')
    const headEnd = old.content_md.length - body.length // frontmatter 占用的前缀长度
    const linesToOffset = (lineIdx: number): number => {
      if (bodyLines.length === 0) return headEnd
      let off = headEnd
      for (let i = 0; i < lineIdx; i++) off += bodyLines[i].length + 1
      return off
    }
    let content: string

    if (input.op === 'append') {
      // 无 anchor：直接追加到正文末尾；有 anchor：追加到该 section 的末尾（下一个同级/更高级标题之前）
      if (!input.anchor) {
        content = bodyText === '' ? input.content_md : bodyText + '\n\n' + input.content_md
      } else {
        const range = this.findSectionRange(bodyLines, input.anchor)
        if (!range) throw new NotFoundError(`锚点标题「${input.anchor}」不存在`)
        const secEnd = linesToOffset(range.end)
        content = bodyText.slice(0, secEnd).replace(/\s+$/, '') + '\n\n' + input.content_md + bodyText.slice(secEnd)
      }
    } else if (input.op === 'insert_before') {
      const range = this.findSectionRange(bodyLines, input.anchor!)
      if (!range) throw new NotFoundError(`锚点标题「${input.anchor}」不存在`)
      const secStart = linesToOffset(range.start)
      content = bodyText.slice(0, secStart).replace(/\s+$/, '') + '\n\n' + input.content_md + '\n\n' + bodyText.slice(secStart)
    } else {
      // replace_section
      const range = this.findSectionRange(bodyLines, input.anchor!)
      if (!range) throw new NotFoundError(`锚点标题「${input.anchor}」不存在`)
      const secStart = linesToOffset(range.start)
      const secEnd = linesToOffset(range.end)
      const before = bodyText.slice(0, secStart).replace(/\s+$/, '')
      const after = bodyText.slice(secEnd)
      content = (before ? before + '\n\n' : '') + input.content_md + (after ? '\n\n' + after : '')
    }

    // 拼回 frontmatter（若无 frontmatter 则 frontmatterJson 为空对象，splitFrontmatter 已剥离）
    const full = frontmatter && Object.keys(frontmatter).length > 0
      ? old.content_md.slice(0, headEnd) + content
      : content
    return this.update(id, { content_md: full, actor: input.actor, expectedVersion: input.expectedVersion })
  }
}
