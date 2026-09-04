# 灵枢 lingshu

个人知识库 daemon——取代 Obsidian vault 的数据库化知识中枢。

> 《黄帝内经·灵枢》讲经络运行；此处知识为节点、召回为经络。

## 架构

```
多 Agent（ZCode / DSH / Claude Code / 人工 CLI）
        │  MCP（stdio） / REST（hook、脚本） / CLI
        ▼
灵枢 daemon（bun 常驻进程，127.0.0.1:7430）
  ├─ CRUD + 版本快照 + 事件流（多 Agent 感知）
  ├─ 混合召回：bge-m3 语义 + FTS5 trigram，RRF 融合
  ├─ 脏队列自动向量化（30s 一批）
  └─ 每日 03:00 备份（VACUUM INTO，7 份轮换）
        ▼
SQLite 单文件（~/.lingshu/lingshu.db，WAL 模式）
```

设计要点：
- **正文永远存原始 markdown**（TEXT 列），元数据存 JSON 列——AI 读写成本最低
- **所有 Agent 走 daemon，不直连数据库**——写串行化、模型单份加载、定时任务可行
- **写冲突 last-write-wins** + versions 快照留底；PUT 传 `version` 则启用乐观锁（409）
- **软删可恢复**，硬删（purge）仅 CLI 可用
- 无双链；tag 自动从 `#tag` 提取

## 快速开始

```bash
cd ~/code/lingshu
SILICONFLOW_API_KEY=你的key bun run src/server/main.ts   # 启动 daemon
bun run src/cli/main.ts status                          # 验证
```

## CLI

```bash
bun run src/cli/main.ts                     # 帮助
  status                                    # daemon 状态
  add <title> [file.md]                     # 新增（无 file 读 stdin）
  get <id|标题>                              # 读全文
  list [--tag=x]                            # 列表
  search <关键词>                            # FTS 关键词搜索
  recall <自然语言问题>                       # 混合召回（语义+关键词）
  changes [sinceId]                         # 事件流（其他 Agent 改了什么）
  import [vaultPath]                        # 导入 Obsidian vault（幂等）
  drain                                     # 全量向量化
  backup                                    # 立即备份
```

环境变量：`LINGSHU_ACTOR`（身份标识，写入 updated_by/changes）、`SILICONFLOW_API_KEY`（向量化，必需）、`LINGSHU_PORT`（默认 7430）。

## REST

```
POST /notes {title, content_md, tags?}        创建
GET  /notes/:id                               读取（?deleted=1 含软删）
PUT  /notes/:id {title?, content_md?, version?}  更新（带 version 启用乐观锁）
DELETE /notes/:id                             软删
POST /notes/:id/restore                       恢复
POST /notes/:id/rollback {version}            回滚到历史版本
GET  /notes/:id/versions                      版本历史
GET  /notes?tag=&limit=                       列表
GET  /search?q=                               FTS 搜索
POST /recall {query, k}                       混合召回
GET  /changes?since=                          事件流
POST /embed/drain                             全量向量化
POST /backup                                  立即备份
GET  /status                                  状态
```

所有请求可带 `x-actor: <身份>` header 标识来源。

## Agent 接入（MCP）

各客户端追加 MCP server（stdio 模式）：

```json
{
  "mcpServers": {
    "lingshu": {
      "command": "bun",
      "args": ["run", "/Users/tal/code/lingshu/src/mcp/main.ts"],
      "env": { "LINGSHU_ACTOR": "zcode" }   // dsh 用 "dsh"，claude code 用 "cc"
    }
  }
}
```

工具集：
| 工具 | 用途 |
|---|---|
| `lingshu_recall` | 语义+关键词混合召回（session 开始/需要背景知识时先调这个） |
| `lingshu_read` | 按 id 或标题读全文 |
| `lingshu_write` | 写入（无 id 创建、有 id 整体重写） |
| `lingshu_search` | 关键词精确搜索（项目名、报错码） |
| `lingshu_changes` | 拉事件流，感知其他 Agent 的变更 |

## 自动召唤（hook）

替代 obsidian-recall，各 Agent 的 UserPromptSubmit hook 里调：

```bash
curl -s http://127.0.0.1:7430/recall -H 'Content-Type: application/json' \
  -d '{"query":"<用户prompt>","k":3}'
```

## 数据文件

- 库：`~/.lingshu/lingshu.db`（+ WAL/SHM）
- 备份：`~/.lingshu/backups/`（每日 03:00，7 份轮换）

## 目录结构

```
src/
├── server/    # Hono REST + daemon 入口 + config
├── mcp/       # MCP stdio server（薄壳，转发 HTTP）
├── cli/       # 命令行客户端 + vault 导入
├── db/        # schema/migrate + repo（全部 SQL）
├── embed/     # embedder（硅基流动 bge-m3）+ 脏队列 pipeline
├── recall/    # 混合召回（向量 + FTS + RRF）
└── scheduler/ # 30s 增量向量化 + 每日备份
```
