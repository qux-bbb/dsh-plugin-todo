# 待办状态分析报告

- 关联待办：`p-mvbsufkd-017gsw`（状态分析优化）·级别 project · 优先级 normal
- 问题原文：*现在感觉状态太多了，有点乱*
- 分析范围：`todo/lib/store.js`（状态机）、`todo/lib/api.js`（面板 API）、`todo/lib/client.js`（面板 UI）、`todo/lib/index.js`（模型工具 + `/todo` 命令）、`todo/test/*`、两份 README
- 基线证据：`todo/` 下 `node --test` 当前 **156 个测试全绿**（41 suites，~2.0s）
- 结论先行：**乱的主要不是"8 个"这个数字，而是三件事叠在一起** —— ① `confirmed` 是一个没有独立信息的中间态；② `open` 与 `working` 差别只在于"是否被认领"；③ 面板把 8 个状态一对一铺成了 10 个筛选页签。建议：状态机 8 → 7（去掉 `confirmed`），展示层 10 个页签 → 3 个分组。

---

## 1. 现状：8 个状态到底在表达什么

| 状态 | 一句话含义 | 谁能让它进入 | 谁能让它离开 | 需要人处理 |
|---|---|---|---|---|
| `proposed` | AI 提议，等人接受 | AI `propose` | 用户 `accept`/`complete`/`reject` | ✅ |
| `open` | 已确认的待办，未开始 | 用户 accept/新建；`reopen` | AI `claim`，用户 `complete` | |
| `working` | 已认领，在做 | AI `claim`；`answer` | AI `submit`/`ask` | |
| `blocked` | 缺信息，等人回答 | AI/system `ask` | 用户/AI `answer` | ✅ |
| `review` | AI 说做完了，等人确认 | AI `submit`（仅此一条入口） | 用户 `confirm`/`reject`/`complete` | ✅ |
| `confirmed` | 人已确认结果 | 用户 `confirm`（仅此一条入口） | AI `complete` | |
| `done` | 完成（终态） | 用户 `complete`，或 AI `complete`（须从 `confirmed`） | 用户 `reopen` | |
| `void` | 作废/撤回（终态） | 任意状态 `void`（`reason` 必填）/ `reject` | 用户 `reopen` | |

两条不可绕过的规则（`lib/store.js:129-141` 的转换表 + `:760-780` 的特判）：

1. `proposed → open` 只能由用户 `accept`；模型不能确认自己提的待办。
2. `done` 必须有一份用户确认记录：模型只能 `complete` 一个 `confirmed` 的待办；用户直接 `complete` 时，该动作本身写入 `approval`。

## 2. 改动面：状态是跨 6 层的契约

任何状态增删都要同步这些地方，这也是"乱感"被放大的原因：

| 文件 | 依赖状态的位置 |
|---|---|
| `todo/lib/store.js` | `STATUSES:48`、`TERMINAL_STATUSES:50`、`STATUS_RANK:78`、`USER_ACTIONS:97-106`、`AI_ACTIONS:113-122`、`TRANSITIONS:129-141`、`USER_COMPLETABLE:144`、`needsAttention:162`、`normalizeStatus:315`、`list` 的 counts/filter `:591-616`、`applyAction` 的 complete/reject 特判 `:760-780`、`summarize`（**不输出** `attention`，`:1029-1053`） |
| `todo/lib/api.js` | `/state` 的 `statuses: [...STATUSES]:214`、每级 `counts`、`?status=` 过滤 `:185-187`、详情里的 `attention: needsAttention(...)`:249 |
| `todo/lib/client.js` | `STATUS_META:40-49`、`FILTERS:51`（10 个页签）、`attentionOf:175`、`matchesFilter:183`、`actionLabel:189`、页签渲染 `:784-799`、行渲染（`blocked.question`:911、`review.submission`:914、`data-attention`:1150、可投递状态 `:1135`） |
| `todo/lib/index.js` | `STATUS_SCHEMA` 由 `STATUSES` 生成 `:65`、`todo_list` 的 enum/描述 `:301-304`、各工具的返回文案（含 `working`/`review`/`confirmed` 字样 `:179,458,573,608`）、`/todo` 的列表与详情 `:917-950`、投递 prompt `:948` |
| 测试（6 个文件） | `store.test.js`（255 处状态字面量 / `confirmed` 23 处）、`invariants.test.js`（状态 × 动作 × 角色的全交叉矩阵，35/4）、`client.test.js`（72/5）、`api.test.js`（50/2）、`plugin.test.js`（28/0）、`targets.test.js`（1/0） |
| 文档 | 根 `README.md:8-10` 的状态机图、`todo/README.md:19-22` 的两条规则 |

## 3. 诊断："乱"具体来自哪 5 处

**D1 · `confirmed` 没有独立信息量（最该删）**
它的唯一入口是用户 `confirm`，唯一出口是 AI `complete`；而用户在 `review` 上本来就有 `complete`（`USER_ACTIONS.review:102`，`USER_COMPLETABLE:144`），可以**一步从 `review` 直接到 `done`**。也就是说同一个"人确认了结果"的事实，有时走一步、有时走两步，取决于由谁收尾。`confirmed` 存在的唯一作用是"把 `done` 的盖章权留给模型"，代价是多一个状态 + 一次模型往返 + 面板多一个页签（"已确认"）。

**D2 · `open` 与 `working` 只差一个"已认领"标记**
两者的合法动作几乎一样（`request`/`complete`/`update`/`void`），差别是 `submit` 只在 `working`/`blocked` 合法。这个差别用 `claimedBy`/`startedAt` 字段就能表达，不必须是一个状态。但它对"交给 AI 完成"的可见反馈有用（点完能看到"进行中"），所以**不建议顺手删**。

**D3 · 用户会看到两个"待确认"**
`proposed` = "待确认"，`review` = "待确认完成"（`client.js:41-42`）。语义上没错，但并列出现时观感就是"两个差不多的状态"。这是**文案/分组问题，不是状态机问题**。

**D4 · 8 个状态一对一铺成 10 个页签**
`FILTERS:51` = `attention, proposed, review, blocked, working, confirmed, open, done, void, all`。其中 `attention` 是客户端伪筛选，和真实状态并列在同一个 tab 条上；日常真正会用到的只有 3 类。页签体量=状态数，所以"状态太多"的第一眼感受其实来自这里。

**D5 · 三处重复的"需要人处理"判定**
`store.needsAttention`（`:162`）、`api` 详情里的 `attention`（`:249`）、`client` 自己重算的 `todo.status === 'proposed' || 'review' || 'blocked'`（`:183`、`:1150`）。`summarize` 不输出 `attention`，所以列表行只能靠客户端重算 —— 多一个状态就要多改一处，容易漏。

附加观察：`void` 被标注为终态，但 `reopen` 允许从 `void` 回到 `open`（`TRANSITIONS.reopen:138`），"终态"并不真的终；`reject` 一个动作在 `proposed`/`review` 下分别指向 `void`/`working`，靠特判区分（`:770-774`）。

## 4. 逐状态评估

| 状态 | 判断 | 理由 |
|---|---|---|
| `proposed` | **保留** | 承载硬规则 1（AI 不能自证），且在面板上必须显眼 |
| `open` | **保留** | "还没开工"是用户最关心的一档 |
| `working` | **保留（可降级为字段）** | 有"已认领"的真实语义；降级是可选优化 |
| `blocked` | **保留** | 硬规则之外的"等人回答"，与 `review` 的"等确认"不同 |
| `review` | **保留** | 承载硬规则 2 的入口；删掉它等于删掉确认门 |
| `confirmed` | **建议删除** | 见 D1，可被 `done` + `approval` 完全吸收 |
| `done` | **保留** | 终态 |
| `void` | **保留** | 保留记录比真删除更适合"从哪来回哪去"的场景；但需明确它可被 `reopen` |
| ~~`review`+`blocked` 合并~~ | **不建议** | 会把"等确认结果"与"等补充信息"混成一个待办桶，用户无法一眼分辨要做什么 |

## 5. 方案对比

| | 状态集合 | 个数 | 两条硬规则 | 改动文件 | 测试影响 | 风险 | 用户可感知变化 |
|---|---|---|---|---|---|---|---|
| **0 · 只改展示** | 不变 | 8 | 不变 | `client.js` | `client.test.js` 少量 | 极低 | 10 页签 → 3 组；状态中文化；状态机不动 |
| **A · 去 `confirmed`**（推荐） | proposed, open, working, blocked, review, done, void | **7** | 不变（更强：模型彻底没有 `done` 通道） | `store.js` `api.js` `client.js` `index.js` 两份 README | `store.test.js` ~23 处、`invariants.test.js` 4 处、`client.test.js` 5 处、`api.test.js` 2 处 | 中：`todo_complete` 工具语义变化 | 用户 `confirm` 即完成，少一次模型往返；少一个页签 |
| **B · A + `working` 降级为字段** | proposed, open, blocked, review, done, void | **6** | 不变 | 上面 + `claimedBy` 字段与 `submit` 前置条件 | 另需重写 `claim`/`submit`/`ask` 的交叉矩阵 | 中高：`submit` 的前置从状态变为字段，"进行中"的可见反馈要重做 | 面板少一档"进行中"（收进"进行中"分组） |
| **C · 激进 4 状态** | proposed, open, review, done | 4 | 可保留，但 `review` 必须留 | 全链路重写 + 删除语义入口 | 大面积改写 | 高 | `blocked` 变 `question` 字段、`void` 变真删除；失去"作废留档"与"缺信息等待"的显性区分 |

## 6. 推荐：方案 A + 展示层收敛

**状态机（8 → 7）**

```
AI propose → proposed ─用户 accept→ open ─AI claim→ working ─AI submit→ review ─用户 confirm→ done
            └用户 reject→ void                          └用户 confirm/reject→ done / working
```

- `confirm` 的目标状态由 `confirmed` 改为 `done`，并在同一动作里写入 `approval`（复用现有 `approval` 字段，不新增数据结构）。
- `AI_ACTIONS` 里删除 `complete`；`applyAction` 的 `by === 'ai' && previous.status !== 'confirmed'` 特判（`:760`）整段删除。
- 结果：模型**没有任何路径**可以自己把待办标成 `done`，硬规则 2 从"运行时检查"升级为"结构上不可能违反"。
- 连带收敛：`todo_complete` 工具对模型不再有意义（`index.js:608` 的描述、以及各流程里"等用户确认后再调 `todo_complete`"的往返都可以去掉）。**这是本方案唯一需要你拍板的行为变化**：模型侧工具从 8 个减到 7 个。

**展示层（10 页签 → 3 组）**

| 页签 | 覆盖状态 | 含义 |
|---|---|---|
| 待我处理 | proposed / review / blocked | 只有你能推进的 |
| 进行中 | open / working | 队列里和正在做的 |
| 全部 | 其余（含 done / void 折叠） | 归档查询 |

配套：
- 行内文案统一中文，去掉 `open`/`done`/`void` 直接显示英文原词的情况（`client.js:798` 的 `?? candidate` 兜底路径）。
- `attention` 的判定改为**只信服务端**：`summarize`（`store.js:1029`）补输出 `attention: needsAttention(todo.status)`，`client.js:183/:1150` 改为读字段，消掉 D5 的重复真源。

**兼容**：按你的选择不做数据迁移。仅保留/加强 `normalizeStatus`（`store.js:315`）兜底：未知状态（含历史 `confirmed`）一律降级为 `open`——若希望历史 `confirmed` 读成 `done` 而不是 `open`，把映射表从 1 行改成 2 行即可，建议顺手做，成本为零。

**不建议现在做 B**：把 `working` 降级为字段的确能再少一个状态，但 `submit` 的前置条件要从状态改成字段、`api` 的"交给 AI 完成"可见反馈要重做，收益（-1 状态）小于改动面。等 A 落地、面板分组跑顺后再评估。

## 7. 建议写入验收标准（可直接回填本条待办）

1. `STATUSES.length === 7`，且 `grep -rn "\bconfirmed\b" todo/lib todo/test` 只命中迁移注释/映射，不再有状态机与 UI 的 `confirmed` 分支。
2. 两条硬规则有测试：`proposed` 下模型任何动作都不能使其离开 `proposed`；`review --用户 confirm--> done` 且 `todo.approval` 有用户记录（现有 `invariants.test.js:156-183` 与 `store.test.js:621+` 改为新语义后仍覆盖）。
3. `cd todo; node --test` 全绿（预期 ~150 个，删掉仅服务 `confirmed` 的用例后）。
4. 面板筛选页签 ≤ 4 个（待我处理 / 进行中 / 全部 / 已完成），不再出现英文状态名；`confirmed` 页签消失。
5. 根 `README.md` 的状态机图与 `todo/README.md` 的规则说明同步更新。

## 8. 需要你拍板的 3 个决策点

1. **模型侧工具是否接受 `todo_complete` 下线？**（A 方案的直接后果；若不接受，就退化为方案 0 只改展示层）
2. **`confirm` 后是否允许"已确认但还没完成"？**若需要（比如确认后仍要等一次交付检查），`confirmed` 就不能删。
3. **`void` 是否保留**（留档 + 可 `reopen`）还是改成真删除？这决定 `reopen` 的终态语义。
