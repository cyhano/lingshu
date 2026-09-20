// vectorIndex.ts — 内存向量矩阵缓存（方案 A）
// 语义召回的暴力余弦从「每次全量读盘 + JSON.parse」改为「一次性加载进内存 Float32Array 矩阵」。
// 数据规模（个人库几千 chunk）下余弦本身只要 ~7ms，真正的开销是 JSON 文本读盘+反序列化（~130ms）；
// 改为 BLOB 存储（schema v2）+ 内存矩阵后，稳态召回降到 ~6ms，且向量变更走惰性重建（标脏 → 下次 search 前 rebuild）。

import { Repo } from '../db/repo.ts'

export interface VectorHit {
  noteId: string
  score: number
  chunkText: string
  heading: string  // 命中 chunk 所属的标题路径（如「## 已知坑」），用于 Agent 精准引用到段落
}

/**
 * 向量索引：持有全量 chunk 向量的扁平矩阵（N × dim）+ 每 chunk 元数据 + 预计算模长。
 * - 维度从首个合法 chunk 的字节长度推断（bge-m3=1024，测试 FakeEmbedder=8），不硬编码。
 * - 维度混存（换模型残留）或字节数非 4 倍数的脏 chunk 在加载时跳过（对齐旧「坏向量容错」语义）。
 * - markDirty() 后惰性重建：pipeline 写新 embedding 后调用，下次 search 前一次性 rebuild（BLOB 后只需 ~20ms）。
 */
export class VectorIndex {
  private mat: Float32Array | null = null   // N × dim 扁平矩阵
  private norms: Float32Array | null = null // 每 chunk 预计算模长（避免每次点积重复算）
  private noteIds: string[] = []
  private chunkTexts: string[] = []
  private chunkHeadings: string[] = []
  private dim = 0
  private dirty = true

  constructor(private repo: Repo) {}

  /** 向量有变更（写新 embedding / 重切块）后调用；下次 search 前惰性重建 */
  markDirty(): void {
    this.dirty = true
  }

  /** 已加载的向量条数（0 = 尚未加载或库中无已向量化 chunk） */
  get size(): number {
    return this.noteIds.length
  }

  /**
   * 语义召回：query 向量 vs 全部 chunk 向量，取每篇笔记的最佳 chunk，返回 top-candidates。
   * @param qvec query 向量（Float32Array，与库向量同维度）
   * @param candidates 返回候选数
   */
  search(qvec: Float32Array, candidates: number): VectorHit[] {
    if (this.dirty) this.rebuild()
    if (!this.mat || qvec.length !== this.dim) return []

    const qnorm = norm(qvec)
    if (qnorm === 0) return []

    // 每篇笔记取最佳 chunk 的分数与文本
    const bestPerNote = new Map<string, VectorHit>()
    const n = this.noteIds.length
    for (let i = 0; i < n; i++) {
      const off = i * this.dim
      const dot = dotProduct(qvec, this.mat, off, this.dim)
      const nrm = this.norms![i]
      if (nrm === 0) continue
      const score = dot / (nrm * qnorm)
      const noteId = this.noteIds[i]
      const prev = bestPerNote.get(noteId)
      if (!prev || score > prev.score) {
        bestPerNote.set(noteId, { noteId, score, chunkText: this.chunkTexts[i], heading: this.chunkHeadings[i] })
      }
    }

    return [...bestPerNote.values()].sort((a, b) => b.score - a.score).slice(0, candidates)
  }

  /** 预热：立即从 repo 加载构建矩阵（消除首次 search 的冷启动延迟 ~20ms）。daemon 启动后调用一次。 */
  warmup(): void {
    this.rebuild()
  }

  /** 从 repo 全量加载已向量化 chunk，构建扁平矩阵（BLOB 直接 view，零 JSON.parse） */
  private rebuild(): void {
    const chunks = this.repo.allEmbeddedChunks()
    this.dirty = false

    if (chunks.length === 0) {
      this.mat = null
      this.norms = null
      this.noteIds = []
      this.chunkTexts = []
      this.chunkHeadings = []
      this.dim = 0
      return
    }

    // 推断维度：首个字节数是 4 的整数倍的合法 chunk 决定 dim
    let dim = 0
    for (const c of chunks) {
      if (c.embedding && c.embedding.byteLength > 0 && c.embedding.byteLength % 4 === 0) {
        dim = c.embedding.byteLength / 4
        break
      }
    }
    if (dim === 0) {
      this.mat = null
      this.norms = null
      this.noteIds = []
      this.chunkTexts = []
      this.chunkHeadings = []
      this.dim = 0
      return
    }

    // 收集合法 chunk（维度一致、字节数 = dim*4），跳过脏 chunk
    const valid: Array<{ noteId: string; text: string; heading: string; vec: Float32Array }> = []
    let corrupted = 0
    for (const c of chunks) {
      if (!c.embedding || c.embedding.byteLength !== dim * 4) { corrupted++; continue }
      // 显式传 byteOffset/length：c.embedding 是 Uint8Array，若未来被 subarray 切片则 byteOffset 非 0，
      // 直接 view 整个 buffer 会读到错误数据；这里按实际字节区间精确构造 Float32Array view
      valid.push({
        noteId: c.note_id,
        text: c.content,
        heading: c.heading_path,
        vec: new Float32Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength / 4),
      })
    }

    const n = valid.length
    const mat = new Float32Array(n * dim)
    const norms = new Float32Array(n)
    const noteIds = new Array<string>(n)
    const chunkTexts = new Array<string>(n)
    const chunkHeadings = new Array<string>(n)
    for (let i = 0; i < n; i++) {
      mat.set(valid[i].vec, i * dim)
      norms[i] = norm(valid[i].vec)
      noteIds[i] = valid[i].noteId
      chunkTexts[i] = valid[i].text
      chunkHeadings[i] = valid[i].heading
    }

    this.mat = mat
    this.norms = norms
    this.noteIds = noteIds
    this.chunkTexts = chunkTexts
    this.chunkHeadings = chunkHeadings
    this.dim = dim

    if (corrupted > 0) {
      console.warn(`[lingshu] 向量索引跳过 ${corrupted} 个损坏/维度不匹配的 chunk（建议重新向量化）`)
    }
  }
}

/** 向量模长 */
function norm(v: Float32Array): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s)
}

/** 点积：query vs 矩阵第 row 行（从 off 偏移起 dim 维） */
function dotProduct(q: Float32Array, mat: Float32Array, off: number, dim: number): number {
  let dot = 0
  for (let i = 0; i < dim; i++) dot += q[i] * mat[off + i]
  return dot
}
