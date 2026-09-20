// schema.ts — 灵枢存储层 schema 与初始化
// 单库单文件：notes(事实) + tags + versions(版本) + changes(事件流) + chunks(切块) + FTS5(全文)
// 向量不在此表——embedding 以 JSON 文本存于 chunks 表（bge-m3 1024 维，个人库规模暴力余弦毫秒级）

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export const SCHEMA_VERSION = 3

export function openDb(dbPath: string): Database {
  // 确保父目录存在（首次运行 ~/.lingshu 尚未创建）
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

export function migrate(db: Database): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number }
  if (row.user_version >= SCHEMA_VERSION) return

  // v1：建初始表结构（空库首跑）
  if (row.user_version < 1) migrateV1(db)

  // v2：embedding 从 JSON 文本迁移为二进制 BLOB（Float32Array.buffer）
  // 收益：磁盘占用降约 5 倍（21.7KB→4KB/chunk）、召回缓存构建零 JSON.parse
  if (row.user_version < 2) migrateV2(db)

  // v3：新增召回反馈表（recall_feedback），沉淀「这条召回有没有帮上忙」的信号
  if (row.user_version < 3) migrateV3(db)

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

function migrateV1(db: Database): void {
  db.transaction(() => {
    // ── 事实表：正文永远是原始 markdown ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        content_md   TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        frontmatter  TEXT NOT NULL DEFAULT '{}',
        version      INTEGER NOT NULL DEFAULT 1,
        updated_by   TEXT NOT NULL DEFAULT 'human',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        deleted_at   TEXT
      )
    `)

    // ── 标签（多对多）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        tag     TEXT NOT NULL,
        PRIMARY KEY (note_id, tag)
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)')

    // ── 版本历史：每次写前快照，可回滚 ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS versions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id    TEXT NOT NULL,
        version    INTEGER NOT NULL,
        title      TEXT NOT NULL,
        content_md TEXT NOT NULL,
        actor      TEXT NOT NULL,
        ts         TEXT NOT NULL
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS idx_versions_note ON versions(note_id, version)')

    // ── 事件流：append-only，多 Agent 感知彼此变更 ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS changes (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id TEXT NOT NULL,
        op      TEXT NOT NULL,
        actor   TEXT NOT NULL,
        title   TEXT NOT NULL,
        ts      TEXT NOT NULL
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS idx_changes_id ON changes(id)')

    // ── 切块：向量化单元 ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        heading_path TEXT NOT NULL DEFAULT '',
        content      TEXT NOT NULL,
        embedding    BLOB,            -- Float32Array.buffer 二进制向量，NULL = 待向量化（脏标记）；v1 时为 JSON 文本，v2 迁移转 BLOB
        content_hash TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE (note_id, seq)
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_note ON chunks(note_id)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_dirty ON chunks(embedding) WHERE embedding IS NULL')

    // ── 全文索引：trigram 支持中文 ──
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title, content_md,
        content='notes', content_rowid='rowid', tokenize='trigram'
      )
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, content_md)
        VALUES (new.rowid, new.title, new.content_md);
      END
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content_md)
        VALUES ('delete', old.rowid, old.title, old.content_md);
      END
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF title, content_md ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content_md)
        VALUES ('delete', old.rowid, old.title, old.content_md);
        INSERT INTO notes_fts(rowid, title, content_md)
        VALUES (new.rowid, new.title, new.content_md);
      END
    `)
  })()
}

/**
 * v1→v2：embedding 列从 JSON 文本（number[]）迁移为 BLOB（Float32Array.buffer）。
 * 只改存储编码，不改列名/维度/语义；容错跳过损坏行，损坏的向量保持原样（召回时按脏数据跳过）。
 */
function migrateV2(db: Database): void {
  // 只处理 embedding 非空且仍是 JSON 文本的行（未迁移过的）
  const rows = db
    .query(`SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND typeof(embedding) = 'text'`)
    .all() as Array<{ id: number; embedding: string }>
  if (rows.length === 0) return

  const update = db.query('UPDATE chunks SET embedding = ? WHERE id = ?')
  let converted = 0
  let skipped = 0
  db.transaction(() => {
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.embedding) as number[]
        if (!Array.isArray(arr) || arr.length === 0) { skipped++; continue }
        // Float32Array.buffer → Uint8Array（bun:sqlite 以 BLOB 存 Uint8Array）
        update.run(new Uint8Array(new Float32Array(arr).buffer), r.id)
        converted++
      } catch {
        skipped++ // 损坏 JSON 保留原文（召回层容错跳过）
      }
    }
  })()
  console.log(`[lingshu] migrate v2: embedding JSON→BLOB 转换 ${converted} 个，跳过 ${skipped} 个`)
}

/**
 * v2→v3：新增召回反馈表 recall_feedback。
 * 记录 Agent 对某条召回结果的反馈（hit=帮上忙 / miss=没用），按 note_id 聚合可指导：
 * - 长期调 RRF 权重、识别「召回了但没用」与「该召回没召回」的笔记；
 * - 提示某笔记 N 次 miss 建议合并/改写。
 */
function migrateV3(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recall_feedback (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id   TEXT NOT NULL,
      query     TEXT NOT NULL,
      verdict   TEXT NOT NULL CHECK (verdict IN ('hit', 'miss')),
      actor     TEXT NOT NULL,
      ts        TEXT NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_note ON recall_feedback(note_id)')
}
