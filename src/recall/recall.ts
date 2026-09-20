// recall.ts — 混合召回：向量语义 + FTS5 关键词，RRF 融合排序
// 语义路对「意思相近」敏感，关键词路对「精确词」（项目名、报错码）敏感，融合后两者兼顾

import { Repo, NoteRow } from '../db/repo.ts'
import { Embedder } from '../embed/embedder.ts'
import { VectorIndex } from './vectorIndex.ts'

export interface RecallHit {
  note: NoteRow
  score: number          // RRF 融合分
  vec_score: number      // 语义相似度（0-1，无则 0）
  fts_rank: number       // FTS 命中排名（1 起，未命中为 0）
  snippet: string        // 最佳匹配 chunk 摘要
  tags: string[]
}

const RRF_K = 60 // 标准倒数排名常数

export class RecallService {
  constructor(
    private repo: Repo,
    private embedder: Embedder,
    private index: VectorIndex,
  ) {}

  async recall(query: string, k = 5, vecCandidates = 50, ftsCandidates = 20): Promise<RecallHit[]> {
    const q = query.trim()
    if (!q) return []

    // ── 双路并行 ──
    const [vecRanked, ftsRanked] = await Promise.all([
      this.vectorRank(q, vecCandidates),
      Promise.resolve().then(() => this.repo.search(q, ftsCandidates).map((r) => r.id)),
    ])

    // ── RRF 融合：score = Σ 1/(K + rank) ──
    const fused = new Map<string, { score: number; vecScore: number; ftsRank: number; chunkText: string }>()
    for (const [rank, hit] of vecRanked.entries()) {
      fused.set(hit.noteId, { score: 1 / (RRF_K + rank + 1), vecScore: hit.score, ftsRank: 0, chunkText: hit.chunkText })
    }
    for (const [rank, noteId] of ftsRanked.entries()) {
      const existing = fused.get(noteId)
      if (existing) {
        existing.score += 1 / (RRF_K + rank + 1)
        existing.ftsRank = rank + 1
      } else {
        fused.set(noteId, { score: 1 / (RRF_K + rank + 1), vecScore: 0, ftsRank: rank + 1, chunkText: '' })
      }
    }

    // ── 取 top-k 并组装 ──
    const top = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, k)
    const notes = this.repo.notesByIds(top.map(([id]) => id))
    const noteMap = new Map(notes.map((n) => [n.id, n]))
    const hits: RecallHit[] = []
    for (const [noteId, meta] of top) {
      const note = noteMap.get(noteId)
      if (!note) continue
      hits.push({
        note,
        score: meta.score,
        vec_score: meta.vecScore,
        fts_rank: meta.ftsRank,
        snippet: meta.chunkText || this.makeSnippet(note.content_md, q),
        tags: this.repo.getTags(noteId),
      })
    }
    return hits
  }

  /** 语义路：query 向量 vs 内存矩阵（VectorIndex），取每篇笔记最佳 chunk */
  private async vectorRank(query: string, candidates: number) {
    if (!this.embedder.ready) return [] as Array<{ noteId: string; score: number; chunkText: string }>
    const qvec = await this.embedder.embedOne(query)
    if (qvec.length === 0) return [] as Array<{ noteId: string; score: number; chunkText: string }>

    // 向量矩阵在内存中（VectorIndex），搜索本身零读盘零反序列化
    return this.index.search(new Float32Array(qvec), candidates)
  }

  /** FTS 兜底摘要：取查询词附近片段 */
  private makeSnippet(content: string, query: string, len = 120): string {
    const { body } = { body: content.replace(/^---\n[\s\S]*?\n---\n?/, '') }
    const idx = body.toLowerCase().indexOf(query.toLowerCase())
    if (idx < 0) return body.slice(0, len).replace(/\n+/g, ' ')
    const start = Math.max(0, idx - 40)
    return body.slice(start, start + len).replace(/\n+/g, ' ')
  }
}
