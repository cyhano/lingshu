// pipeline.ts — 脏队列向量化流水线
// 周期性取 embedding IS NULL 的 chunk → 批量向量 → 回写
// 失败的 chunk 保持 NULL，下一轮自动重试（天然的重试语义）

import { Repo } from '../db/repo.ts'
import { Embedder } from './embedder.ts'

export class EmbedPipeline {
  private running = false

  constructor(
    private repo: Repo,
    private embedder: Embedder,
  ) {}

  get busy(): boolean {
    return this.running
  }

  /** 处理一批脏 chunk，返回本轮成功条数；无可处理返回 0 */
  async processBatch(batchSize = 32): Promise<number> {
    if (this.running) return 0
    if (!this.embedder.ready) return 0
    this.running = true
    try {
      const dirty = this.repo.dirtyChunks(batchSize)
      if (dirty.length === 0) return 0
      const vectors = await this.embedder.embedMany(dirty.map((c) => c.content))
      const items = dirty
        .map((c, i) => ({ id: c.id, embedding: vectors[i] ?? [] }))
        .filter((it) => it.embedding.length > 0)
      if (items.length > 0) this.repo.writeEmbeddings(items)
      return items.length
    } finally {
      this.running = false
    }
  }

  /** 阻塞式全量向量化（import 后首次调用），带进度回调 */
  async drainAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    let done = 0
    const total = this.repo.dirtyCount()
    onProgress?.(0, total)
    while (true) {
      const n = await this.processBatch(64)
      if (n === 0) break
      done += n
      onProgress?.(done, total)
    }
  }
}
