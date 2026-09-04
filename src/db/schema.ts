// schema.ts — 灵枢存储层 schema 与初始化
// 单库单文件：notes(事实) + tags + versions(版本) + changes(事件流) + chunks(切块) + FTS5(全文)
// 向量不在此表——embedding 以 JSON 文本存于 chunks 表（bge-m3 1024 维，个人库规模暴力余弦毫秒级）

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export const SCHEMA_VERSION = 1

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
        embedding    TEXT,            -- JSON number[]，NULL = 待向量化（脏标记）
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

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  })()
}
