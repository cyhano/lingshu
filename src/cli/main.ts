#!/usr/bin/env bun
// main.ts — 灵枢 CLI：daemon 的命令行皮 + vault 导入
// 所有数据操作走 HTTP（除 import 直接写库——它在 daemon 未启动时也要能用）

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { openDb, migrate } from '../db/schema.ts'
import { Repo } from '../db/repo.ts'
import { loadConfig } from '../server/config.ts'

const config = loadConfig()
const BASE = `http://${config.host}:${config.port}`

async function api(method: string, pathName: string, body?: unknown, actor = 'human'): Promise<any> {
  const resp = await fetch(BASE + pathName, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-actor': actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    console.error(`✗ ${resp.status} ${JSON.stringify(json)}`)
    process.exit(1)
  }
  return json
}

function assertDaemon(): Promise<any> {
  return api('GET', '/status').catch(async () => {
    console.error(`✗ 灵枢 daemon 未运行（${BASE}）`)
    console.error(`  先启动: lingshu serve  或  bun run /Users/tal/code/lingshu/src/server/main.ts`)
    process.exit(1)
  })
}

const [cmd, ...args] = process.argv.slice(2)
const ACTOR = process.env.LINGSHU_ACTOR || 'human'

switch (cmd) {
  case 'serve': {
    // 真正拉起 daemon：动态 import server/main.ts（与 `bun run src/server/main.ts` 等价，但路径不硬编码）
    await import('../server/main.ts')
    break
  }

  case 'status': {
    const s = await assertDaemon()
    console.log(`✓ 灵枢运行中 @ ${BASE}`)
    for (const [k, v] of Object.entries(s)) console.log(`  ${k}: ${v}`)
    break
  }

  case 'add': {
    // lingshu add <title> [file.md]  （无 file 则读 stdin）
    const title = args[0]
    if (!title) { console.error('用法: lingshu add <title> [markdown文件]'); process.exit(1) }
    let content = ''
    if (args[1]) content = readFileSync(args[1], 'utf8')
    else content = await new Response(Bun.stdin.stream()).text()
    const note = await api('POST', '/notes', { title, content_md: content }, ACTOR)
    console.log(`✓ 已创建 ${note.id} v${note.version} 《${note.title}》`)
    break
  }

  case 'get': {
    const note = await api('GET', `/notes/${encodeURIComponent(args[0])}`)
    console.log(`# ${note.title}  (v${note.version}, by ${note.updated_by})`)
    console.log(`# tags: ${note.tags.join(', ')} | updated: ${note.updated_at}`)
    console.log('---')
    console.log(note.content_md)
    break
  }

  case 'list': {
    const qs = new URLSearchParams()
    if (args[0]?.startsWith('--tag=')) qs.set('tag', args[0].slice(6))
    const notes = await api('GET', `/notes?${qs}`)
    for (const n of notes) console.log(`${n.id}  ${n.updated_at.slice(0, 16)}  v${n.version}  《${n.title}》`)
    console.log(`共 ${notes.length} 条`)
    break
  }

  case 'search': {
    const q = args.join(' ')
    if (!q) { console.error('用法: lingshu search <关键词>'); process.exit(1) }
    const rows = await api('GET', `/search?q=${encodeURIComponent(q)}`)
    for (const r of rows) console.log(`${r.id}  《${r.title}》`)
    if (rows.length === 0) console.log('（无结果）')
    break
  }

  case 'recall': {
    const q = args.join(' ')
    if (!q) { console.error('用法: lingshu recall <自然语言问题>'); process.exit(1) }
    const hits = await api('POST', '/recall', { query: q, k: 5 })
    for (const [i, h] of hits.entries()) {
      console.log(`${i + 1}. 《${h.title}》 score=${h.score} vec=${h.vec_score} fts=${h.fts_rank} [${h.tags.join(',')}]`)
      console.log(`   ${h.snippet}`)
    }
    break
  }

  case 'changes': {
    const since = args[0] ? Number(args[0]) : 0
    const rows = await api('GET', `/changes?since=${since}`)
    for (const r of rows) console.log(`#${r.id} ${r.ts.slice(0, 16)} ${r.actor.padEnd(6)} ${r.op.padEnd(7)} ${r.title}`)
    break
  }

  case 'backup': {
    await assertDaemon()
    const r = await api('POST', '/backup')
    console.log(`✓ 备份完成 → ${r.path}`)
    break
  }

  case 'import': {
    // 直连库导入 vault（daemon 可未启动）；导入完提示 drain
    const vaultPath = args[0] || config.vaultPath
    if (!existsSync(vaultPath)) { console.error(`vault 不存在: ${vaultPath}`); process.exit(1) }
    const db = openDb(config.dbPath)
    migrate(db)
    const repo = new Repo(db)
    const files = collectMd(vaultPath)
    let imported = 0, skipped = 0
    for (const f of files) {
      const rel = path.relative(vaultPath, f)
      const content = readFileSync(f, 'utf8')
      // 以 vault 相对路径作为幂等键：已存在同名笔记则跳过（重复导入安全）
      const existing = repo.resolve(rel) || repo.resolve(path.basename(f, '.md'))
      if (existing) { skipped++; continue }
      repo.create({ title: rel, content_md: content, actor: 'import' })
      imported++
    }
    db.close()
    console.log(`✓ 导入完成: ${imported} 新增, ${skipped} 跳过（共扫描 ${files.length} 个 md）`)
    console.log(`  下一步: 启动 daemon 后执行 lingshu drain 完成向量化`)
    break
  }

  case 'drain': {
    await assertDaemon()
    console.log('开始全量向量化（阻塞式）...')
    const r = await api('POST', '/embed/drain')
    console.log(`✓ 向量化完成，剩余待处理: ${r.pending}`)
    break
  }

  default:
    console.log(`灵枢 lingshu — 个人知识库 daemon 客户端

用法:
  lingshu status                     查看 daemon 状态
  lingshu add <title> [file.md]      新增笔记（无 file 读 stdin）
  lingshu get <id>                   读取笔记全文
  lingshu list [--tag=x]             列出笔记
  lingshu search <关键词>             FTS 全文搜索
  lingshu recall <自然语言>           语义+关键词混合召回
  lingshu changes [sinceId]          事件流（多 Agent 感知）
  lingshu import [vaultPath]         导入 Obsidian vault
  lingshu drain                      全量向量化（import 后）
  lingshu backup                     立即备份

环境变量: LINGSHU_ACTOR（身份标识）、SILICONFLOW_API_KEY（向量化）
daemon 地址: ${BASE}`)
}
process.exit(0)

/** 递归收集 md 文件（跳过 .obsidian 等） */
function collectMd(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules') continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...collectMd(p))
    else if (name.endsWith('.md')) out.push(p)
  }
  return out
}
