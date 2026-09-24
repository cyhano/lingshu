// recall.ts — 混合召回：向量语义 + FTS5 关键词，RRF 融合排序
// 语义路对「意思相近」敏感，关键词路对「精确词」（项目名、报错码）敏感，融合后两者兼顾

import { Repo, NoteRow } from '../db/repo.ts'
import { Embedder } from '../embed/embedder.ts'
import { VectorIndex, VectorHit } from './vectorIndex.ts'

export interface RecallHit {
  note: NoteRow
  score: number          // RRF 融合分
  vec_score: number      // 语义相似度（0-1，无则 0）
  fts_rank: number       // FTS 命中排名（1 起，未命中为 0）
  snippet: string        // 最佳匹配 chunk 摘要
  heading: string        // 命中 chunk 所属标题路径（语义路命中时有值，纯 FTS 命中为空）
  tags: string[]
}

const RRF_K = 60 // 标准倒数排名常数

// ── 融合调参 ──
// 纯 RRF 只用排名（1/(K+rank)），语义路的真实余弦相似度（0~1）完全不参与排序，
// 导致「余弦 0.9 的笔记」与「余弦 0.5 的笔记」只要排名相邻，融合分几乎无差别（1/61 vs 1/62），
// 且 FTS 命中哪怕一条词也能反超高相似度语义命中。这里把真实相似度加权纳入融合分：
//   fused = VEC_WEIGHT * cos_sim  +  1/(K+rank)  （语义路）
//   fused = 1/(K+rank)                            （FTS 路，精确词命中）
const VEC_WEIGHT = 1.0      // 语义相似度权重（cos_sim ∈ [0,1]，加权后与 RRF 项同量纲）

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

    // ── 加权融合：语义路用真实余弦相似度加权，FTS 路用 RRF 排名项 ──
    // score = VEC_WEIGHT * cos_sim + 1/(K+rank)（语义路）；score = 1/(K+rank)（FTS 路）
    const fused = new Map<string, { score: number; vecScore: number; ftsRank: number; chunkText: string; heading: string }>()
    for (const [rank, hit] of vecRanked.entries()) {
      fused.set(hit.noteId, {
        score: VEC_WEIGHT * hit.score + 1 / (RRF_K + rank + 1),
        vecScore: hit.score,
        ftsRank: 0,
        chunkText: hit.chunkText,
        heading: hit.heading,
      })
    }
    for (const [rank, noteId] of ftsRanked.entries()) {
      const existing = fused.get(noteId)
      if (existing) {
        existing.score += 1 / (RRF_K + rank + 1)
        existing.ftsRank = rank + 1
      } else {
        fused.set(noteId, { score: 1 / (RRF_K + rank + 1), vecScore: 0, ftsRank: rank + 1, chunkText: '', heading: '' })
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
        heading: meta.heading,
        tags: this.repo.getTags(noteId),
      })
    }
    return hits
  }

  /** 语义路：query 向量 vs 内存矩阵（VectorIndex），取每篇笔记最佳 chunk */
  private async vectorRank(query: string, candidates: number) {
    if (!this.embedder.ready) return [] as VectorHit[]
    const qvec = await this.embedder.embedOne(query)
    if (qvec.length === 0) return [] as VectorHit[]

    // 向量矩阵在内存中（VectorIndex），搜索本身零读盘零反序列化
    return this.index.search(new Float32Array(qvec), candidates)
  }

  /** FTS 兜底摘要：取查询词附近片段 */
  private makeSnippet(content: string, query: string, len = 120): string {
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '')
    const idx = body.toLowerCase().indexOf(query.toLowerCase())
    if (idx < 0) return body.slice(0, len).replace(/\n+/g, ' ')
    const start = Math.max(0, idx - 40)
    return body.slice(start, start + len).replace(/\n+/g, ' ')
  }
}
