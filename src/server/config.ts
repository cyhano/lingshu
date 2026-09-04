// config.ts — 灵枢配置：环境变量 > 默认值，db 与 key 一处集中

import path from 'node:path'
import { homedir } from 'node:os'

export interface LingshuConfig {
  dbPath: string
  backupDir: string
  port: number
  host: string
  siliconflowKey: string
  vaultPath: string
}

export function loadConfig(): LingshuConfig {
  const root = process.env.LINGSHU_HOME || path.join(homedir(), '.lingshu')
  return {
    dbPath: process.env.LINGSHU_DB || path.join(root, 'lingshu.db'),
    backupDir: process.env.LINGSHU_BACKUP_DIR || path.join(root, 'backups'),
    port: Number(process.env.LINGSHU_PORT || 7430),
    host: process.env.LINGSHU_HOST || '127.0.0.1',
    siliconflowKey: process.env.SILICONFLOW_API_KEY || '',
    vaultPath: process.env.LINGSHU_VAULT || path.join(homedir(), 'obsidian-vault'),
  }
}
