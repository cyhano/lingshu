// main.ts — 灵枢 daemon 入口
// 启动顺序：建库 → 迁移 → 起服务 → 起调度器

import { serve } from 'bun'
import { openDb, migrate } from '../db/schema.ts'
import { Repo } from '../db/repo.ts'
import { Embedder } from '../embed/embedder.ts'
import { EmbedPipeline } from '../embed/pipeline.ts'
import { RecallService } from '../recall/recall.ts'
import { Scheduler } from '../scheduler/scheduler.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

const config = loadConfig()

const log = (msg: string) => console.log(`[lingshu ${new Date().toISOString()}] ${msg}`)

if (!config.siliconflowKey) {
  log('警告：SILICONFLOW_API_KEY 未设置，向量化与语义召回将不可用（FTS 仍可用）')
}

const db = openDb(config.dbPath)
migrate(db)
const repo = new Repo(db)
const embedder = new Embedder({ apiKey: config.siliconflowKey })
const pipeline = new EmbedPipeline(repo, embedder)
const recall = new RecallService(repo, embedder)

const scheduler = new Scheduler({
  db,
  dbPath: config.dbPath,
  backupDir: config.backupDir,
  backupTime: config.backupTime,
  backupKeep: config.backupKeep,
  embedIntervalSec: config.embedIntervalSec,
  processBatch: () => pipeline.processBatch(),
  dirtyCount: () => repo.dirtyCount(),
  log,
})

const app = createApp({
  repo,
  recall,
  pipeline,
  backup: () => scheduler.backup(),
  embedderReady: embedder.ready,
})

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host })
log(`灵枢 daemon 已启动 → http://${config.host}:${config.port}`)
log(`数据库: ${config.dbPath}`)
scheduler.start()

// 优雅退出：关库
process.on('SIGINT', () => { scheduler.stop(); db.close(); process.exit(0) })
process.on('SIGTERM', () => { scheduler.stop(); db.close(); process.exit(0) })
