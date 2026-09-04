// test/helpers.ts — 测试公共设施：隔离的临时库 + 测试 app
// 每个 test 文件用 createTestEnv() 拿到完全隔离的 db + repo + recall，互不污染

import { openDb, migrate } from '../src/db/schema.ts'
import { Repo } from '../src/db/repo.ts'
import { RecallService } from '../src/recall/recall.ts'
import { EmbedPipeline } from '../src/embed/pipeline.ts'
import { Embedder } from '../src/embed/embedder.ts'
import { createApp } from '../src/server/app.ts'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface TestEnv {
  repo: Repo
  app: Hono
  recall: RecallService
  pipeline: EmbedPipeline
  cleanup: () => void
}

/** 假 embedder：不调 API，用确定性哈希伪向量（测试召回排序逻辑足够） */
export class FakeEmbedder extends Embedder {
  private counter = 0
  override get ready(): boolean {
    return true
  }
  override async embedMany(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.fakeVec(t))
  }
  private fakeVec(text: string): number[] {
    // 生成 8 维伪向量：按文本哈希确定，相同文本同向量，相近前缀有部分相关性
    const v = new Array(8).fill(0)
    for (let i = 0; i < text.length; i++) {
      v[i % 8] += text.charCodeAt(i) / text.length
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / norm)
  }
}

export function createTestEnv(): TestEnv {
  const dir = mkdtempSync(path.join(tmpdir(), 'lingshu-test-'))
  const db = openDb(path.join(dir, 'test.db'))
  migrate(db)
  const repo = new Repo(db)
  const embedder = new FakeEmbedder()
  const pipeline = new EmbedPipeline(repo, embedder)
  const recall = new RecallService(repo, embedder)
  const app = createApp({
    repo,
    recall,
    pipeline,
    backup: () => dir + '/backup.db',
  })
  return {
    repo,
    app,
    recall,
    pipeline,
    cleanup: () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 便捷请求：调 Hono app（不起真实端口） */
export async function req(app: Hono, method: string, pathName: string, body?: unknown, actor?: string): Promise<{ status: number; json: any }> {
  const res = await app.request(pathName, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(actor ? { 'x-actor': actor } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}
