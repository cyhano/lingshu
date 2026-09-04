// embedder.ts — 硅基流动 bge-m3 embedding 客户端（复用自 obsidian-embed，行为不变）

const DEFAULT_ENDPOINT = 'https://api.siliconflow.cn/v1/embeddings'
const DEFAULT_MODEL = 'BAAI/bge-m3'

/** 归一化文本：去多余空白 */
export function normalize(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

export interface EmbedderOptions {
  endpoint?: string
  model?: string
  apiKey?: string
  timeoutMs?: number
}

export class Embedder {
  endpoint: string
  model: string
  apiKey: string
  timeoutMs: number

  constructor(opts: EmbedderOptions = {}) {
    this.endpoint = opts.endpoint || process.env.SILICONFLOW_API_KEY_ENDPOINT || DEFAULT_ENDPOINT
    this.model = opts.model || process.env.SILICONFLOW_EMBED_MODEL || DEFAULT_MODEL
    this.apiKey = opts.apiKey || process.env.SILICONFLOW_API_KEY || ''
    this.timeoutMs = opts.timeoutMs ?? 10000
  }

  get ready(): boolean {
    return Boolean(this.apiKey)
  }

  async embedMany(texts: string[], batchSize = 32): Promise<number[][]> {
    const cleaned = texts.map(normalize)
    if (cleaned.length === 0) return []
    const vectors: number[][] = []
    for (let i = 0; i < cleaned.length; i += batchSize) {
      const batch = cleaned.slice(i, i + batchSize)
      vectors.push(...(await this._request(batch)))
    }
    return vectors
  }

  async embedOne(text: string): Promise<number[]> {
    return (await this.embedMany([text]))[0] ?? []
  }

  private async _request(inputs: string[]): Promise<number[][]> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const resp = await fetch(this.endpoint, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: inputs }),
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`embedding 请求失败 ${resp.status}: ${body.slice(0, 200)}`)
      }
      const json = (await resp.json()) as { data?: Array<{ embedding?: number[] }> }
      if (!Array.isArray(json?.data)) throw new Error('embedding 响应缺少 data 数组')
      return json.data.map((d) => {
        if (!Array.isArray(d?.embedding)) throw new Error('embedding 响应缺少 embedding 向量')
        return d.embedding
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 余弦相似度（两向量等长） */
export function cosineSimilarity(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
