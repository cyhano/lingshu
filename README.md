# 灵枢 lingshu

个人知识库 daemon——取代 Obsidian vault 的数据库化知识中枢。

> 《黄帝内经·灵枢》讲经络运行；此处知识为节点、召回为经络。

## 给 AI 的一句话速览（Agent 接入必读）

灵枢是你的**持久记忆系统**：用 `lingshu_recall` 查「有没有相关的既有知识/历史决策」，用 `lingshu_read` 读全文，用 `lingshu_write`（整体重写）或 `lingshu_patch`（按标题锚点局部改）写，用 `lingshu_search` 精确查项目名/报错码，用 `lingshu_changes` 看其他 Agent 改了什么。**写任何笔记前必须先 `lingshu_read`**（否则会被 read-before-write 保护拒绝）。所有数据存 SQLite（`~/.lingshu/lingshu.db`），语义召回走 bge-m3 向量 + FTS 关键词的 RRF 混合。

## 架构

```
多 Agent（ZCode / DSH / Claude Code / 人工 CLI）
        │  MCP（stdio） / REST（hook、脚本） / CLI / WebUI
        ▼
灵枢 daemon（bun 常驻进程，127.0.0.1:7430）
  ├─ CRUD + 版本快照 + 事件流（多 Agent 感知）
  ├─ 混合召回：bge-m3 语义 + FTS5 trigram，RRF 融合
  ├─ 脏队列自动向量化（30s 一批，可配）
  └─ 每日定时备份（VACUUM INTO，份数轮换，可配）
        ▼
SQLite 单文件（~/.lingshu/lingshu.db，WAL 模式）
```

设计要点：
- **正文永远存原始 markdown**（TEXT 列），元数据存 JSON 列——AI 读写成本最低
- **所有 Agent 走 daemon，不直连数据库**——写串行化、模型单份加载、定时任务可行
- **写冲突 last-write-wins** + versions 快照留底；PUT 传 `version` 则启用乐观锁（409）
- **软删可恢复**，硬删（purge）仅 CLI 可用
- 无双链；tag 自动从 `#tag` 提取
- **语义召回零读盘**：embedding 存 BLOB + 内存向量矩阵（VectorIndex），稳态召回 ~6ms

## 快速开始

```bash
git clone https://github.com/cyhano/lingshu.git
cd lingshu
bun install                                   # 安装依赖（需要 bun ≥ 1.2）
SILICONFLOW_API_KEY=你的key bun run src/server/main.ts   # 启动 daemon
bun run src/cli/main.ts status                # 验证
```

启动后浏览器打开 **http://127.0.0.1:7430/** 即是 WebUI。

[硅基流动 API key](https://siliconflow.cn/) 免费注册可得（bge-m3 embedding 免费额度足够个人使用）。

## WebUI

daemon 内置 Web 页面（`web/index.html`，Vue 3 + markdown-it，CDN 引入零构建），浏览器打开 `http://127.0.0.1:7430/` 即用：

- **三栏布局**：左栏标签云（按计数排序、点击筛选、回收站入口）/ 中栏笔记列表 / 右栏阅读与编辑
- **混合搜索**：顶栏一个框，支持「召回」（语义+关键词融合，展示相似度）与「搜索」（FTS 关键词）双模式
- **阅读**：markdown 渲染、frontmatter 徽章、版本历史下拉（可预览任意历史版本并回滚）
- **编辑**：原始 markdown 编辑（textarea 整体重写）、新建笔记
- **回收站**：软删笔记列表、恢复
- **事件流**：查看各 Agent（zcode/dsh/cc/human）最近的变更记录

WebUI 与 MCP/CLI/REST 走同一套 API，操作全部落 updated_by 与事件流，和 Agent 写入互相可见。

## 配置文件（config.toml）

配置可选，不创建则全用默认值。复制示例开始：

```bash
cp config.example.toml ~/.lingshu/config.toml
```

```toml
[server]
port = 7430                      # 监听端口

[backup]
dir = "~/.lingshu/backups"       # 备份目录（支持 ~）
time = "03:00"                   # 每日备份时刻（本地时间 HH:MM）
keep = 7                         # 保留份数（超出轮换最旧）

[scheduler]
embed_interval_sec = 30          # 增量向量化周期（秒）
```

优先级：**环境变量 > config.toml > 默认值**。环境变量：`LINGSHU_CONFIG`（配置文件路径）、`LINGSHU_DB`、`LINGSHU_BACKUP_DIR`、`LINGSHU_PORT`、`SILICONFLOW_API_KEY`。

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

环境变量：`LINGSHU_ACTOR`（身份标识，写入 updated_by/changes）。

## REST

```
POST /notes {title, content_md, tags?}        创建
GET  /notes/:id                               读取（?deleted=1 含软删）
PUT  /notes/:id {title?, content_md?, version?}  更新（带 version 启用乐观锁）
PATCH /notes/:id {op, content_md, anchor?, version?}  增量写（op=append/insert_before/replace_section）
DELETE /notes/:id                             软删
POST /notes/:id/restore                       恢复
POST /notes/:id/rollback {version}            回滚到历史版本
GET  /notes/:id/versions                      版本历史
GET  /notes?tag=&limit=&deleted=               列表（deleted=1 只返回已软删/回收站；deleted=all 含未删与已删；默认只返回未删）
GET  /tags                                    标签云（计数）
GET  /trash/count                             回收站计数
GET  /search?q=                               FTS 搜索
POST /recall {query, k}                       混合召回（结果含 heading=命中段落的标题路径）
POST /recall/:id/feedback {verdict, query?}   召回反馈（verdict=hit/miss，沉淀召回质量信号）
GET  /recall/feedback                         每篇笔记的反馈统计（按 miss 降序）
GET  /changes?since=&limit=                   事件流
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
      "args": ["run", "/path/to/lingshu/src/mcp/main.ts"],
      "env": { "LINGSHU_ACTOR": "zcode" }
    }
  }
}
```

每个 Agent 用不同的 `LINGSHU_ACTOR`（如 `zcode` / `dsh` / `cc`），身份自动落到 `updated_by` 和事件流。

工具集：
| 工具 | 用途 |
|---|---|
| `lingshu_recall` | 语义+关键词混合召回（session 开始/需要背景知识时先调这个）；结果含 `heading` 命中段落标题 |
| `lingshu_read` | 按 id 或标题读全文（写前必读，快照版本作为写基线） |
| `lingshu_write` | 写入（无 id 创建、有 id 整体重写；带 read-before-write 写保护） |
| `lingshu_patch` | 增量写（append / insert_before / replace_section，按标题锚点定位，无需重发全文） |
| `lingshu_search` | 关键词精确搜索（项目名、报错码） |
| `lingshu_changes` | 拉事件流，感知其他 Agent 的变更 |
| `lingshu_feedback` | 给召回结果打 hit/miss 反馈，沉淀召回质量信号 |
| `lingshu_delete` | 软删（进回收站，可恢复） |

写入保护（MCP 层，防多 Agent 互相覆盖）：

- **read-before-write**：更新路径要求本会话先 `lingshu_read` 过目标笔记，否则直接拒绝——杜绝盲写。
- **变更检测**：read 之后若笔记版本被其他 Agent 改过，write 返回 `stale_read` 要求重新 read，避免覆盖他人改动。
- **同题查重**：创建时若已存在同题笔记，返回 `duplicate_title` 提示转为 read + 合并更新（如一天多份日报）。
- `version` 参数可选；省略时由 read 基线自动带上乐观锁。

增量写（`lingshu_patch`，解决长笔记「改一行也要整体重写全文」的丢内容风险）：

- 三种模式：`append`（末尾/某章节末追加）、`insert_before`（某标题前插入）、`replace_section`（替换某标题整个章节）。
- 用 markdown 标题锚点定位（如 `anchor: "## 已知坑"`），`#` 前缀可省略，同名标题取第一个；锚点找不到返回 404，可回退 `lingshu_write` 全文写。
- 与 `lingshu_write` 共用 read-before-write 基线和乐观锁，patch 也是一次 update（进版本历史、可回滚）。

## AI 使用最佳实践（写给 Agent）

- **先 recall 再动手**：任何「需要引用既有知识/历史决策/项目背景」的任务，先 `lingshu_recall`，不要凭记忆假设。
- **写前必读**：`lingshu_write` 和 `lingshu_patch` 更新路径都要求本会话先 `lingshu_read` 过目标笔记（read 会把版本快照存进基线），否则拒绝。read 后若别人改过（`stale_read`），重新 read 再写。
- **局部改优先用 patch**：改某章节用 `lingshu_patch`（`append`/`insert_before`/`replace_section` + 标题锚点），避免长笔记整体重写的丢内容风险；只有大改才用 `lingshu_write` 全文重写。
- **建篇前查重**：`lingshu_write` 创建时会自动查同题（`duplicate_title`），若已存在应转为 read + 合并更新，不要重复建篇（尤其日报/周报）。
- **精确词用 search**：项目名、报错码、ID 这类精确串用 `lingshu_search`（FTS），比语义召回准。
- **用 recall 的 heading 精准引用**：`lingshu_recall` 结果带 `heading`（命中段落的标题路径），引用时可精确到「某笔记的某章节」。
- **打反馈改进召回**：对明显有用/没用的召回结果，可调 `lingshu_feedback` 记 hit/miss，长期帮灵枢调优混合召回、识别噪音笔记。
- **感知他人变更**：session 开始拉一次 `lingshu_changes`（增量），了解其他 Agent 最近改了什么，避免重复劳动或覆盖冲突。

## 自动召唤（hook）

各 Agent 的 UserPromptSubmit hook 里调，实现「提问即召回」：

```bash
curl -s http://127.0.0.1:7430/recall -H 'Content-Type: application/json' \
  -d '{"query":"<用户prompt>","k":3}'
```

## pm2 常驻

```bash
pm2 start ecosystem.config.cjs    # key 从环境变量读
pm2 save
```

## 测试

```bash
bun test        # 89 用例：CRUD/并发/搜索/切块/反馈/边界，FakeEmbedder 零 API 成本
bunx tsc --noEmit  # 类型检查
```

CI（GitHub Actions）在 push/PR 时自动跑这两项。

## 基准

```bash
bun run bench/recall.ts "查询词" 5   # 测语义召回冷启动 vs 稳态耗时（需 daemon 已启动）
```

## 数据文件

- 库：`~/.lingshu/lingshu.db`（+ WAL/SHM）
- 备份：`~/.lingshu/backups/`（默认每日 03:00、保留 7 份，config.toml 可改）

## 目录结构

```
├── config.example.toml   # 配置示例（备份目录/时间/份数、向量化周期等）
├── web/index.html        # 内置 WebUI（Vue3 单文件，零构建）
├── bench/recall.ts       # 语义召回性能基准
├── src/
│   ├── server/           # Hono REST + daemon 入口 + config 加载
│   ├── mcp/              # MCP stdio server（薄壳，转发 HTTP）
│   ├── cli/              # 命令行客户端 + vault 导入
│   ├── db/               # schema/migrate + repo（全部 SQL + 切块 + patch 增量写 + 反馈）
│   ├── embed/            # embedder（硅基流动 bge-m3）+ 脏队列 pipeline
│   ├── recall/           # 混合召回（向量 + FTS + RRF）+ VectorIndex 内存矩阵
│   └── scheduler/        # 定时向量化 + 每日备份轮换
└── test/                 # 89 用例（FakeEmbedder 隔离环境）
```
