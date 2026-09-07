# Ticket 16a 验收报告

Ticket 16a 的全部验收项已实现，工作树保留供 review，未 stage、未 commit。比较基线为 `84c7ee2cb0ff115357cbeefb818094ea2cffae71`；开始时工作树干净。

## 验证结果

| 检查 | 实施前 | 实施后 |
|---|---:|---:|
| `npm test` | 321 passed，14 files | 335 passed，14 files |
| `npm run typecheck` | — | 通过 |
| `git diff --check` | — | 通过 |
| 原 ruling 测试名称与日期 | 16 个命名声明 | 全部保留 |

新增 14 个 ruling 测试，涵盖 C/D/祖先、revert 后继续开发、跨越不适用中间 commit 的后继、预分叉证据冲突、两个数据库连接的跨会话线性写入、路径 archive、兄弟分支 adoption、scope 引用表、多 tip 显示与显式 merge、事务中 base 复检、历史读取不刷新 base、scope 收窄、schema 外键，以及 Integration/NEAR/accounting 的路径集合。旧 fixture 的非法跨 scope 引用已改为合法来源；旧版本号和 mark/status 断言已改为全局 commit ID 与路径结果，golden 已更新。

## 验收映射

| Ticket 条目 | 实现与证据 |
|---|---|
| Schema | identity 保留；删除 current/status 和 per-identity rev；commit 使用 id、parent_id；merge links 指向 commit；archive 的 text/supports 为空；没有迁移代码 |
| Store current | `currentCommit(id, path)` 返回所有 tip（包含 archive）；`listCurrentKnowledge(path, filter)` 返回注入用集合；沿完整父图排除有适用后继的 commit |
| Tool/base | 工具绑定时冻结读取集合；bare trace 重读当前集合，显式 trace 只记录其 commit；submit 预检与 SQLite immediate transaction 内复检；任一错误整批不写，结果保持逐项顺序 |
| Citation | supports 和 because 均使用同一个 store scope/path 校验；本会话的非祖先事实返回指定 adoption 提示；其他会话按 session/project/global 区分 |
| Consumers | injection、compaction、Recording context、Integration context、NEAR、accounting 均使用路径 current；context-free current 保留所有 tips |
| Marks/read | store `mark(commitId, kind)`；façade 支持显式 commit 与路径 bare identity；多 tip 的 bare 写入拒绝；历史、diff、tree、search、分页仍可读 |
| Tests/report | 指定 A/B 测试及既有 ruling 保留；本报告含逐文件行数与全部 SQL 差异 |

## 设计选择

- **归属**：选择由 commit 的 run/session 判定 scope 归属；identity 的 origin 保持稳定。这样新的 scope 不覆盖历史 commit。project 归属随显式 session/project 声明或 merge 变化，不从 cwd 推断。
- **路径**：显式路径为 `{sessionId, headTurnId}`，head 可为 null；context-free 为 null。既有仅传 session 的接口以最新 turn 补全路径；仅传 Integration branch 时从 recorded/manual head 补全。新调用者可直接传 head，host 的后续调整属于 16b。
- **计算**：读取时扫描 commit DAG，按事实与 scope 判断 applicability，再排除适用后继。没有 shared-head registry，也不按最大 commit ID 选择胜者。数据量扩大后可按实测需求索引或缓存，现有代码注释标明这一界限。
- **兼容字段**：operation 的 `expectedRevision`、receipt/audit 的 `rev` 和 links 的 `from_rev/to_rev` 保留字段名，数值均为全局 commit ID；模型 `KnowledgeRevision` 自身已无 `rev`。`K1@1..2` 继续兼容，也支持 `K1@1..K1@2`。16b 继续完善完整树呈现、search notes、prompts 和 host。

## 生产代码行数

下表以 Git diff 的增加/删除行数为准，包含空行和注释；测试、snapshot 与本报告不计入生产代码。

| 文件 | 原行数 | 新行数 | 增加 | 删除 | 净变化 |
|---|---:|---:|---:|---:|---:|
| `core/api/index.ts` | 220 | 226 | +16 | -10 | +6 |
| `core/api/read.ts` | 130 | 138 | +23 | -15 | +8 |
| `core/api/tools.ts` | 174 | 179 | +10 | -5 | +5 |
| `core/integration/commit.ts` | 95 | 108 | +28 | -15 | +13 |
| `core/integration/index.ts` | 136 | 139 | +10 | -7 | +3 |
| `core/integration/memory.ts` | 46 | 60 | +21 | -7 | +14 |
| `core/model/index.ts` | 317 | 314 | +4 | -7 | -3 |
| `core/recording/index.ts` | 127 | 127 | +2 | -2 | +0 |
| `core/render/index.ts` | 208 | 207 | +4 | -5 | -1 |
| `core/store/index.ts` | 1079 | 1049 | +171 | -201 | -30 |
| 合计 | 2532 | 2547 | +289 | -274 | +15 |

## Schema 变更

- `knowledge`：删除 `status`、`current_revision`。
- `knowledge_revisions`：删除 `rev` 与其 unique key；添加 nullable FK `parent_id`；添加 `(knowledge_id, id)` unique key，供 link/mark 联合外键验证 identity 与 commit 一致。
- `knowledge_links`：联合外键改为引用 `knowledge_revisions(knowledge_id, id)`；字段名保留，值变为 commit ID。
- `knowledge_marks`：`rev` 改为 `commit_id`；每 commit 唯一；联合外键约束 identity 与 commit。
- index：`idx_knowledge_project_status(project_id, status)` 改为 `idx_knowledge_project(project_id)`。

## Query 完整差异

以下从基线与当前 `core/store/index.ts` 的每个 `.prepare(...)` 提取 SQL，忽略空白差异、合并相同 SQL。DDL 已单列。旧查询共移除或替换 13 种，新增或替换为 11 种；其余 SQL 文本未变。

### 旧查询

1. `core/store/index.ts:712`（基线）。

```sql
SELECT * FROM knowledge_revisions WHERE knowledge_id = ? AND rev = ?
```

2. `core/store/index.ts:726`（基线）。

```sql
SELECT * FROM knowledge_revisions WHERE knowledge_id = ? ORDER BY rev ASC
```

3. `core/store/index.ts:744`（基线）。

```sql
SELECT 1 FROM knowledge WHERE id = ? AND origin_session_id = ?
```

4. `core/store/index.ts:749`（基线）。

```sql
SELECT e.*, r.id AS rev_id, r.rev AS rev_rev, r.text AS rev_text, r.category AS rev_category,
                r.scope AS rev_scope, r.supports AS rev_supports, r.op AS rev_op, r.because AS rev_because,
                r.run_id AS rev_run_id, r.created_at AS rev_created_at
         FROM knowledge e
         JOIN knowledge_revisions r ON r.knowledge_id = e.id AND r.rev = e.current_revision
         WHERE e.status = 'active'
           AND (
             r.scope = 'global'
             OR (r.scope = 'project' AND e.project_id = ?)
             OR (r.scope = 'session' AND e.project_id = ? AND e.origin_session_id = ?)
           )
         ORDER BY e.id ASC
```

5. `core/store/index.ts:842`（基线）。

```sql
INSERT INTO knowledge (project_id, origin_session_id, status, author, current_revision) VALUES (?, ?, 'active', ?, 1)
```

6. `core/store/index.ts:861`（基线）。

```sql
UPDATE knowledge SET current_revision = ?, project_id = ? WHERE id = ?
```

7. `core/store/index.ts:887`（基线）。

```sql
UPDATE knowledge SET status = 'merged' WHERE id = ?
```

8. `core/store/index.ts:908`（基线）。

```sql
UPDATE knowledge SET current_revision = ?, status = 'archived' WHERE id = ?
```

9. `core/store/index.ts:930`（基线）。

```sql
INSERT INTO knowledge_revisions (knowledge_id, rev, text, category, scope, supports, op, because, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

10. `core/store/index.ts:938`（基线）。

```sql
INSERT INTO knowledge_marks (knowledge_id, rev, kind, created_at) VALUES (?, ?, ?, ?)
```

11. `core/store/index.ts:1000`（基线）。

```sql
UPDATE knowledge SET project_id = ? WHERE id IN (
        SELECT e.id FROM knowledge e JOIN knowledge_revisions r ON r.knowledge_id = e.id AND r.rev = e.current_revision
        WHERE r.scope = 'session' AND e.origin_session_id = ?)
```

12. `core/store/index.ts:1011`（基线）。

```sql
DELETE FROM knowledge_marks WHERE knowledge_id = ? AND rev = ?
```

13. `core/store/index.ts:1039`（基线）。

```sql
SELECT knowledge_id, rev FROM knowledge_revisions
      WHERE text LIKE ? ESCAPE '\\' ORDER BY knowledge_id, rev
```

### 新查询

1. `core/store/index.ts:713`（当前）。

```sql
SELECT * FROM knowledge_revisions WHERE knowledge_id = ? AND id = ?
```

2. `core/store/index.ts:726`（当前）。

```sql
SELECT * FROM knowledge_revisions WHERE knowledge_id = ? ORDER BY id
```

3. `core/store/index.ts:761`（当前）。

```sql
SELECT * FROM knowledge_revisions ORDER BY id
```

4. `core/store/index.ts:763`（当前）。

```sql
SELECT from_rev, to_rev FROM knowledge_links WHERE kind = 'merged_into'
```

5. `core/store/index.ts:823`（当前）。

```sql
WITH RECURSIVE
      edges(parent, child) AS (
        SELECT parent_id, id FROM knowledge_revisions WHERE parent_id IS NOT NULL
        UNION SELECT from_rev, to_rev FROM knowledge_links WHERE kind = 'merged_into'
      ), descendants(id) AS (
        SELECT ? UNION SELECT e.child FROM edges e JOIN descendants d ON e.parent = d.id
      ) SELECT id FROM descendants
```

6. `core/store/index.ts:895`（当前）。

```sql
INSERT INTO knowledge (project_id, origin_session_id, author) VALUES (?, ?, ?)
```

7. `core/store/index.ts:898`（当前）。

```sql
INSERT INTO knowledge_revisions (knowledge_id, parent_id, text, category, scope, supports, op, because, run_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

8. `core/store/index.ts:913`（当前）。

```sql
INSERT INTO knowledge_marks (knowledge_id, commit_id, kind, created_at) VALUES (?, ?, ?, ?)
```

9. `core/store/index.ts:978`（当前）。

```sql
SELECT * FROM knowledge_revisions WHERE id = ?
```

10. `core/store/index.ts:981`（当前）。

```sql
DELETE FROM knowledge_marks WHERE commit_id = ?
```

11. `core/store/index.ts:1009`（当前）。

```sql
SELECT knowledge_id, id FROM knowledge_revisions
      WHERE text LIKE ? ESCAPE '\\' ORDER BY knowledge_id, id
```

### SQL 未变的语义变更

- `INSERT knowledge_links` 与 `SELECT knowledge_links`：`from_rev/to_rev` 现在是 commit ID；用于 merge 父边，不再配合 identity status mutation。
- `INSERT/UPDATE runs`：保存新 commit 操作回执；commit 的 parent_id/merge links 永久记录实际提交 base。`readKnowledgeRevisions` 保留初始快照，重读内容可在 toolCalls/fetched 追溯。
- `UPDATE knowledge SET project_id`：仅保留原 project merge 重标记；scope 变化不再更新 identity 上的 current/status/project。
- `SELECT knowledge WHERE id`：映射为稳定 identity，不再读取 current/status。
- `SELECT facts/turns/sessions/runs`：被 current/applicability 和 citation 校验复用；读取查询本身没有权限限制。
- `listVisibleKnowledge` 的调用方全部接入路径 current；NEAR 对同 identity 的多 tip 输出独立 commit 地址。

## 独立审查

**Standards**：发现历史 trace 误刷新 base、link/mark 缺失联合外键两项，均已修复并补回归；复查无遗留项。

**Spec**：发现历史 trace base、project 首次注入的 scope 过滤顺序、连续显式读取丢失其他 tip、merged-away 冲突未命名 survivor 四项，均已修复并补回归。

## 验收自查

- [x] Ticket 的 7 项验收要求均有实现与验证。
- [x] `npm run typecheck`、`npm test`、`git diff --check` 通过；335 个测试全部通过。
- [x] 原 ruling 测试名称与日期全部保留；没有删除测试来获得通过。
- [x] 未新增依赖、迁移代码或 shared-head registry。
- [x] 未改 prompts 或 host 生产实现；工作树未提交，保留 review。
