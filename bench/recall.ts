// bench/recall.ts — 语义召回端到端基准
// 直接打 daemon 的 /recall 接口，测量冷启动（首次 rebuild）与稳态（内存矩阵）的耗时。
// 用法：daemon 启动后  bun run bench/recall.ts [查询词] [次数]
// 示例：bun run bench/recall.ts "ABC Reading 首屏优化" 5

const BASE = process.env.LINGSHU_BASE || 'http://127.0.0.1:7430'
const query = process.argv[2] || '灵枢 召回 性能'
const rounds = Math.max(1, Number(process.argv[3]) || 5)

async function recall(q: string): Promise<number> {
  const t0 = performance.now()
  const resp = await fetch(`${BASE}/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, k: 5 }),
  })
  const ms = performance.now() - t0
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`recall ${resp.status}: ${body.slice(0, 200)}`)
  }
  const json = (await resp.json()) as Array<{ title: string; score: number; heading?: string }>
  console.log(`  ${ms.toFixed(1)}ms  →  ${json.map((h) => `《${h.title}》(${h.heading || '-'})`).join('  ') || '(无结果)'}`)
  return ms
}

async function main() {
  // 先确认 daemon 存活
  const st = await fetch(`${BASE}/status`).catch(() => null)
  if (!st?.ok) {
    console.error(`✗ daemon 未运行 @ ${BASE}，先启动: bun run src/server/main.ts`)
    process.exit(1)
  }

  console.log(`基准查询: "${query}" × ${rounds} 次 @ ${BASE}\n`)

  // 第 1 次含冷启动（VectorIndex 首次 rebuild）
  console.log('── 冷启动（含首次向量矩阵重建）──')
  await recall(query)

  // 后续稳态
  console.log('\n── 稳态（内存矩阵已就绪）──')
  let sum = 0
  for (let i = 0; i < rounds; i++) {
    sum += await recall(query)
  }
  console.log(`\n稳态均值: ${(sum / rounds).toFixed(1)}ms / 次`)
}

await main()
