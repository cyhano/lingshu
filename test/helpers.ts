// test/helpers.ts — 测试公共设施：隔离的临时库 + 测试 app
// 每个 test 文件用 createTestEnv() 拿到完全隔离的 db + repo + recall，互不污染

import { openDb, migrate } from '../src/db/schema.ts'
import { Repo } from '../src/db/repo.ts'
import { RecallService } from '../src/recall/recall.ts'
import { VectorIndex } from '../src/recall/vectorIndex.ts'
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
    // 生成 64 维伪向量：按「字符 bigram」集合哈希，共享字符序列（同词/同短语）会产生相关向量，
    // 贴近真实 bge-m3 的「语义相近 → 向量相近」行为，使语义召回排序的测试具备可信度。
    // 维度取 64（远大于 8）以降低中文 bigram 哈希碰撞，避免无关短文本算出虚高余弦。
    // 相同文本 → 相同向量（余弦 1）；共享 bigram 越多 → 余弦越高；无关文本 → 余弦趋近 0。
    const DIM = 64
    const v = new Array(DIM).fill(0)
    const s = text.toLowerCase()
    for (let i = 0; i < s.length; i++) {
      // 取当前位置的单字符 + 下一个字符构成 bigram，散列到 DIM 维之一并累加
      const gram = i + 1 < s.length ? s.slice(i, i + 2) : s.slice(i)
      let h = 0
      for (let j = 0; j < gram.length; j++) h = (h * 31 + gram.charCodeAt(j)) >>> 0
      v[h % DIM] += 1
    }
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1
    return v.map((x) => x / norm)
  }
}

export function createTestEnv(): TestEnv {
  const dir = mkdtempSync(path.join(tmpdir(), 'lingshu-test-'))
  const db = openDb(path.join(dir, 'test.db'))
  migrate(db)
  const repo = new Repo(db)
  const embedder = new FakeEmbedder()
  const index = new VectorIndex(repo)
  const pipeline = new EmbedPipeline(repo, embedder, () => index.markDirty())
  const recall = new RecallService(repo, embedder, index)
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
