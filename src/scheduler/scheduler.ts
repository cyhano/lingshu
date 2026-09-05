// scheduler.ts — daemon 内置调度器
// - 周期处理脏队列（增量向量化，间隔可配）
// - 每日定时备份（VACUUM INTO，份数轮换可配；时间默认 03:00）
// 备份是写时快照（WAL 安全），期间不阻塞读写

import { Database } from 'bun:sqlite'
import { readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { isBackupTime } from '../server/config.ts'

export interface SchedulerDeps {
  db: Database
  dbPath: string
  backupDir: string
  backupTime: string       // "HH:MM"
  backupKeep: number
  embedIntervalSec: number
  processBatch: () => Promise<number>
  dirtyCount: () => number
  log: (msg: string) => void
}

export class Scheduler {
  private timers: ReturnType<typeof setInterval>[] = []
  private lastBackupDate = ''

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    // 周期增量向量化（间隔可配，默认 30s）
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
      }, this.deps.embedIntervalSec * 1000),
    )

    // 每分钟检查是否到了每日备份时间（默认 03:00，可配）
    this.timers.push(
      setInterval(() => {
        if (isBackupTime(this.deps.backupTime, this.lastBackupDate)) {
          this.lastBackupDate = new Date().toISOString().slice(0, 10)
          try {
            this.backup()
          } catch (e) {
            this.deps.log(`备份失败: ${(e as Error).message}`)
          }
        }
      }, 60_000),
    )

    this.deps.log(`调度器已启动（增量向量化 ${this.deps.embedIntervalSec}s / 备份每日 ${this.deps.backupTime}，保留 ${this.deps.backupKeep} 份）`)
  }

  /** SQLite 在线备份（VACUUM INTO 快照，WAL 安全）+ 轮换 */
  backup(): string {
    if (!existsSync(this.deps.backupDir)) mkdirSync(this.deps.backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = path.join(this.deps.backupDir, `lingshu-${stamp}.db`)
    // 用 backup API 而非直接复制，避免 WAL 中途态；参数化防路径引号问题
    this.deps.db.exec('VACUUM INTO ?', [dest])
    this.rotate()
    this.deps.log(`备份完成 → ${dest}`)
    return dest
  }

  private rotate(): void {
    const files = readdirSync(this.deps.backupDir)
      .filter((f) => f.startsWith('lingshu-') && f.endsWith('.db'))
      .sort()
      .reverse()
    for (const f of files.slice(this.deps.backupKeep)) {
      unlinkSync(path.join(this.deps.backupDir, f))
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }
}
