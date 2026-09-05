// config.ts — 灵枢配置加载
// 优先级：环境变量 > config.toml > 默认值
// 配置文件位置：$LINGSHU_CONFIG 或 ~/.lingshu/config.toml（可选，不存在时全用默认值）

import path from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'

export interface LingshuConfig {
  dbPath: string
  backupDir: string
  backupTime: string        // "HH:MM" 本地时间
  backupKeep: number        // 备份保留份数
  embedIntervalSec: number  // 增量向量化周期（秒）
  port: number
  host: string
  siliconflowKey: string
  vaultPath: string
}

/** 展开 ~ 前缀 */
function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2))
  return p
}

/** 解析 "HH:MM"，非法则返回 null */
function parseTimeOfDay(s: unknown): { hour: number; minute: number } | null {
  if (typeof s !== 'string') return null
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const hour = Number(m[1]), minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function loadToml(): Record<string, any> {
  const configPath = process.env.LINGSHU_CONFIG || path.join(homedir(), '.lingshu', 'config.toml')
  if (!existsSync(configPath)) return {}
  try {
    return Bun.TOML.parse(readFileSync(configPath, 'utf8')) as Record<string, any>
  } catch (e) {
    console.warn(`[lingshu] 配置文件解析失败（${configPath}），将使用默认值: ${(e as Error).message}`)
    return {}
  }
}

export function loadConfig(): LingshuConfig {
  const toml = loadToml()
  const root = process.env.LINGSHU_HOME || path.join(homedir(), '.lingshu')

  const tServer = toml.server ?? {}
  const tDb = toml.database ?? {}
  const tEmbed = toml.embedding ?? {}
  const tBackup = toml.backup ?? {}
  const tSched = toml.scheduler ?? {}

  // 备份时间校验：非法值回落 03:00 并警告
  let backupTime = typeof tBackup.time === 'string' ? tBackup.time : '03:00'
  if (!parseTimeOfDay(backupTime)) {
    console.warn(`[lingshu] 配置 backup.time="${backupTime}" 非法（应为 HH:MM），回落 03:00`)
    backupTime = '03:00'
  }

  const keepRaw = Number(tBackup.keep ?? 7)
  const backupKeep = Number.isFinite(keepRaw) && keepRaw >= 1 ? Math.trunc(keepRaw) : 7

  const intervalRaw = Number(tSched.embed_interval_sec ?? 30)
  const embedIntervalSec = Number.isFinite(intervalRaw) && intervalRaw >= 5 ? Math.trunc(intervalRaw) : 30

  return {
    dbPath: process.env.LINGSHU_DB || expandHome(tDb.path ?? path.join(root, 'lingshu.db')),
    backupDir: process.env.LINGSHU_BACKUP_DIR || expandHome(tBackup.dir ?? path.join(root, 'backups')),
    backupTime,
    backupKeep,
    embedIntervalSec,
    port: Number(process.env.LINGSHU_PORT || tServer.port || 7430),
    host: process.env.LINGSHU_HOST || tServer.host || '127.0.0.1',
    siliconflowKey: process.env.SILICONFLOW_API_KEY || tEmbed.api_key || '',
    vaultPath: process.env.LINGSHU_VAULT || path.join(homedir(), 'obsidian-vault'),
  }
}

/** 供 scheduler 判断是否到了每日备份时间 */
export function isBackupTime(backupTime: string, lastBackupDate: string, now = new Date()): boolean {
  const t = parseTimeOfDay(backupTime)
  if (!t) return false
  const today = now.toISOString().slice(0, 10)
  if (lastBackupDate === today) return false
  return now.getHours() === t.hour && now.getMinutes() === t.minute
}
