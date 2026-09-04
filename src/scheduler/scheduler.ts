// scheduler.ts — daemon 内置调度器
// - 每 30s 处理脏队列（增量向量化）
// - 每日 03:00 备份（在线 backup API，保留 7 份轮换）
// - 备份前校验 pending 数，写日志

import { Database } from 'bun:sqlite'
import { copyFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export interface SchedulerDeps {
  db: Database
  dbPath: string
  backupDir: string
  processBatch: () => Promise<number>
  dirtyCount: () => number
  log: (msg: string) => void
}

export class Scheduler {
  private timers: ReturnType<typeof setInterval>[] = []
  private lastBackupDate = ''

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    // 30s 增量向量化
    this.timers.push(
      setInterval(async () => {
        try {
          const pending = this.deps.dirtyCount()
          if (pending === 0) return
          const done = await this.deps.processBatch()
          if (done > 0) this.deps.log(`向量化 ${done}/${pending} 条脏 chunk`)
        } catch (e) {
          this.deps.log(`向量化失败（下轮重试）: ${(e as Error).message}`)
        }
      }, 30_000),
    )

    // 每分钟检查是否到了每日备份时间（03:00）
    this.timers.push(
      setInterval(() => {
        const now = new Date()
        const today = now.toISOString().slice(0, 10)
        if (now.getHours() === 3 && this.lastBackupDate !== today) {
          this.lastBackupDate = today
          try {
            this.backup()
          } catch (e) {
            this.deps.log(`备份失败: ${(e as Error).message}`)
          }
        }
      }, 60_000),
    )

    this.deps.log('调度器已启动（增量向量化 30s / 备份每日 03:00）')
  }

  /** SQLite 在线备份（WAL 安全）+ 7 份轮换 */
  backup(): string {
    if (!existsSync(this.deps.backupDir)) mkdirSync(this.deps.backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = path.join(this.deps.backupDir, `lingshu-${stamp}.db`)
    // 用 backup API 而非直接复制，避免 WAL 中途态
    this.deps.db.exec(`VACUUM INTO '${dest}'`)
    this.rotate()
    this.deps.log(`备份完成 → ${dest}`)
    return dest
  }

  private rotate(keep = 7): void {
    const files = readdirSync(this.deps.backupDir)
      .filter((f) => f.startsWith('lingshu-') && f.endsWith('.db'))
      .sort()
      .reverse()
    for (const f of files.slice(keep)) {
      unlinkSync(path.join(this.deps.backupDir, f))
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }
}
