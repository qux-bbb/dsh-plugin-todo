# dsh-plugin-todo

一个 DeepSeek Harness（DSH）插件：**人和 AI 协作的待办清单，所有"确认"都留在人手里**。

参考 `dsh-plugin-notepad` 的插件骨架（工具 + 明文 JSONL 存储 + 侧边栏面板 + 宿主路由），
在同一个架构上换成了**带确认的工作流**：

- AI 可以提待办，但**必须由你在面板里确认**才会变成真正的待办；
- 你可以在面板里手动加待办；
- 你可以把某条待办**交给 AI**：宿主把它作为一条用户消息投递进当前会话，AI 醒来后先判断信息是否足够，不够就提问/让你在面板里补答，够了再动手；
- AI 做完后只能提交"待确认"，**你在面板确认之后**，AI 或你才能把它标记为已完成；
- 每条待办可以点开看/改详情，也可以作废。

```
dsh-plugin-todo/
├─ todo/                       # 插件包本体（可单独拷进 profile）
│  ├─ package.json             # 含 dsh.client（浏览器半声明）与 exports["./client"]
│  ├─ lib/index.js             # 宿主半入口：name / inject / Config / apply + 8 个工具 + /todo + HTTP 路由
│  ├─ lib/store.js             # 存储层 + 工作流状态机（两条确认规则在这里强制）
│  ├─ lib/api.js               # 面板用的 JSON API（纯处理函数，可单测）
│  ├─ lib/client.js            # 浏览器半：手写的经典脚本，无需编译
│  └─ test/                    # node:test 单元测试
├─ scripts/
│  ├─ install-todo.mjs         # 安装/更新/卸载（profile 级 或 全局级；--files-only / --dry-run / --verify）
│  ├─ smoke-runtime.mjs        # 真 Cordis + 真 tool registry + 真面板 API 的端到端冒烟测试
│  └─ dev-link.ps1             # 开发期把 DSH 的 @deepseek-ai/* 链接到本仓库
└─ node_modules/@deepseek-ai   # dev-link.ps1 生成的 junction（仅为本地跑测试）
```

## 两条不可绕过的规则

这两条不是"提示词约定"，而是 `lib/store.js` 里的一张转换表：面板 API 和模型工具走**同一份代码**，没法绕开。

| 规则 | 怎么强制的 |
| --- | --- |
| AI 提的待办**不是**待办 | `todo_propose` 建出来的条目状态是 `proposed`；`accept`（`proposed → open`）只允许 `actor: 'user'`。模型调用 `todo_update`/`todo_claim` 都会被拒绝，并收到一句"这是用户的确认动作"。 |
| **没有用户确认，任何东西都到不了 `done`** | `complete` 的规则按 actor 分叉：`actor: 'ai'` 只允许 `confirmed → done`（`confirmed` 只能由用户 `confirm` 产生，且 todo 上会留下 `approval: { at, by: 'user' }`）；`actor: 'user'` 可以从 `proposed/open/working/blocked/review/confirmed` 直接完成，而**这一动作本身就是确认**，代码会同步写入 `approval` 与 `accepted`。 |

于是"由 AI 标记已完成"和"由用户标记已完成"都成立，但两条路都要求先有一次用户确认：

```
review ──用户「确认完成」──► confirmed ──AI todo_complete──► done   （AI 收尾）
review ──用户「标记完成」──────────────────────────────────► done   （用户一步到位，视作确认）
```

## 快速开始

安装脚本幂等（重复执行只更新，不会重复插入），改动前备份补丁文件，`--uninstall` 只删自己写入的区块。

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# 1) 装到当前 desktop profile（桌面端用的就是这个）
& $node scripts\install-todo.mjs --profile desktop

# 2) 或装到「全局」：$DSH_HOME/cordis.patch.yml，对所有 profile 生效
& $node scripts\install-todo.mjs --scope home

# 3) 先看看会改什么（不写盘）；--files-only 只拷文件不动补丁
& $node scripts\install-todo.mjs --profile desktop --dry-run
& $node scripts\install-todo.mjs --profile desktop --files-only

# 4) 卸载
& $node scripts\install-todo.mjs --profile desktop --uninstall
```

生效方式与 notepad 完全一致（同一套 loader 分层：`bundle 补丁 → profile 的 cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch`）：

- **宿主半（工具 + 路由）**：桌面端会热重载补丁文件，实测插入后立即挂载；`apply` 里注册的 `/api/todo` 路由当场可访问。
- **浏览器半（面板图标）**：`clientModules` 把每个 Loader specifier 的包元数据缓存在进程里，**新增浏览器半需要重启一次应用**；之后只改 `lib/client.js` 会被 client-hmr 热重载（500ms 轮询）。

## 状态机

```
                     ┌── 用户 accept ──► open
AI todo_propose ──► proposed
                     └── 用户 reject ──► void

open / working / blocked ──AI todo_claim──► working
working ──AI todo_update(question)（信息不足）──► blocked ──用户回答──► working
working / blocked ──AI todo_submit──► review
review ──用户 confirm──► confirmed ──AI todo_complete──► done
review ──用户打回──► working
任意非 void ──用户/AI todo_void──► void
done / void / confirmed / review / proposed ──用户 reopen──► open
```

| 状态 | 面板上的名字 | 含义 |
| --- | --- | --- |
| `proposed` | 待确认 | AI 提的，等你确认 |
| `open` | 待办 | 真正的待办，还没开始 |
| `working` | 进行中 | 已认领（AI 或你交给 AI） |
| `blocked` | 待补充 | 信息不足，等你回答 |
| `review` | 待确认完成 | AI 说做完了，等你确认结果 |
| `confirmed` | 已确认 | 你已确认，等着被标记完成 |
| `done` | 已完成 | 完成 |
| `void` | 已作废 | 作废，保留记录 |

每个状态的可用动作由 `availableActions(status, actor)` 给出，面板直接照服务端返回的 `actions` 渲染按钮，所以**界面永远不会出现一个服务端会拒绝的按钮**。

## 模型可调用的工具

| 工具 | 作用 |
| --- | --- |
| `todo_propose` | 提一条或多条待办（`todos: [{title, detail, acceptance, priority, tags}]`），落在 `proposed`，需要用户确认 |
| `todo_list` | 按 `status` / `query` / `limit` 读列表；需要人处理的状态（proposed / review / blocked）排在最前 |
| `todo_get` | 读一条的完整记录：详情、验收标准、用户回答、提交结果、确认记录、完整历史 |
| `todo_claim` | 认领并开始（→ `working`），返回"开工前必须核对的信息"清单 |
| `todo_update` | 改字段；用 `question` 记录缺什么信息（→ `blocked`），用 `answer` 把用户刚给的信息写回（→ `working`） |
| `todo_submit` | 提交结果（→ `review`），并把"请你确认"交给用户 |
| `todo_complete` | **只有用户已确认过**才能标记完成（→ `done`） |
| `todo_void` | 作废（需要 `reason` 和 `confirm: true`） |

工具的 `description` 与 `todo_claim` 的渲染结果里都写明了"先判断信息是否足够，不够先问用户"这条流程，避免模型拿着一条半成品待办直接开干。

## 图形界面

- 左侧边栏底部多一个 **待办** 图标（`sidebar.panellist`，order 41），点开在中央主面板（`main`，key 与图标 id 相同为 `todo`）里整块操作。
- **和项目关联**：点开就是当前会话所在项目的待办。顶栏写明「跟随当前会话 / 手动选择 / 默认（最近使用的项目）」+ 项目根路径；下拉可临时切项目，旁边出现「跟随会话」一键回到跟随；面板开着时切换会话，1.5s 内自动跟随。
- **两个层级标签页**：`项目` / `全局`，各自独立列表与文件路径。
- **状态筛选**：`待我处理`（待确认 + 待确认完成 + 待补充）/ 各状态 / 全部，每个标签带计数；顶部还有搜索框与刷新。
- **手动添加**：`＋ 手动添加` 展开表单（标题必填 + 说明 + 验收标准 + 优先级 + 标签），加进去就是 `open`（你自己加的，本身就是确认）。
- **点开看/改详情**：点任意一行展开，显示详细说明、验收标准、待回答的问题、历史回答、AI 提交的结果与证据、你的确认时间、完成/作废信息，以及最近 8 条状态变更历史；`编辑详情` 可以原地改标题/说明/验收标准/优先级/标签。
- **行内动作**：按状态给出 `确认接受` / `交给 AI 完成` / `回答` / `确认完成` / `打回重做` / `标记完成` / `作废` / `重新打开`。`回答`、`打回`、`作废` 都是行内输入框（作废原因可留空，默认「用户作废」）。
- **交给 AI 完成**：点开后先选**投递到哪条会话**，详见下一节。

### 「交给 AI 完成」：能选会话、能新建会话，全局待办还能选项目

点行内「交给 AI 完成」不会盲投，而是展开一个投递目标选择器：

| 待办层级 | 选择器提供 |
| --- | --- |
| 项目级 | **投递到哪个会话**：`当前会话` / `新建会话` / 宿主列出的其他会话（带「同项目 / 运行中 / 需恢复」标记） |
| 全局级 | 同上，**外加**一个「筛选项目」下拉（按项目过滤会话列表）和一个「新会话的项目（工作目录）」下拉（含「手动输入路径…」） |

规则：

- **项目级待办**只落在它自己所属的项目里 —— 新建会话时工作目录固定为该待办的项目根；
- **全局待办**不绑定项目，所以"哪个项目"由你来定：它既是会话列表的过滤条件，也是新会话的工作目录（默认面板当前项目）；列表里没有就手输绝对路径；
- 「当前会话」= 你此刻所在的那条会话（面板通过会话作用域桥接拿到它的 id）。

投递走宿主自己的会话业务 API，所以**冷会话也能用**：

```
面板 ──POST /api/todo/request {target: current|session|new, targetSession?, cwd?}──► 宿主半
                                                                                   │
  1. 拼一段用户口吻的请求（id/标题/说明/验收标准/已有回答 + "先判断信息够不够、不够先问、然后 claim/submit、用户确认后才能 complete"）
  2. target=session → 用面板选中的那条会话；target=new → sessionController.create({cwd}) 先建会话
  3. sessionController.prompt({requestId, sessionId, mode:'queue', content:[{type:'text',...}]})
     —— 它先 **resolve/resume** 目标会话，再把消息放进它的 inbox（等价于你在那条会话里发了一条消息）
  4. 没有 sessionController 时退回 ctx.agents.get(id) + createUserMessage + agent.followup（headless / SDK 部署），
     已有实时 agent 时两者等价
  5. 顺手把待办置为 working（失败也无所谓，AI 自己会 todo_claim）
```

投递不了就返回 **409 + 拼好的提示词**，面板转为"复制提示词"路径；原因都有一句人话：

| 情况 | 返回 |
| --- | --- |
| 没选会话 / 面板不在任何会话里 | `no live session to hand this todo to: ...` |
| 目标会话恢复失败且没有实时 agent | `session <id> could not accept the request: <宿主给的原因>` |
| 宿主不支持新建会话 | `this deployment cannot create sessions; pick an existing session instead, ...` |
| 新建会话的工作目录不是绝对路径 | 400 `cwd must be an absolute path` |
| 配置 `deliverRequests: false` | 面板直接跳过选择器，显示可复制的提示词 |

选择器的数据来自 `GET /api/todo/sessions`：只列**普通会话**（subagent 子树被过滤掉），每条带 `cwd`、`projectRoot`、`running`、`agentAvailable`、`sameProject`。宿主没有会话服务时返回 `canList:false`，面板降级成"当前会话 / 新建会话"，而不是报错。

## 存储格式与两层含义

每行一条 JSON，一层一个文件：

```json
{"id":"p-mv7od8zk-01ro19","scope":"project","title":"给 README 补一节安装说明","detail":"写清楚 profile 级和 home 级两种安装","acceptance":"README 里有可直接复制的命令","tags":["docs"],"priority":"high","status":"done","origin":"ai","at":"2026-10-14T05:37:20.000Z","updatedAt":"2026-10-14T05:38:02.000Z","editedAt":null,"question":null,"answers":[{"at":"...","by":"user","text":"两层都写"}],"agent":{"at":"...","by":"ai"},"submission":{"at":"...","by":"ai","summary":"README 补了两级安装说明","evidence":"README.md +40 行"},"accepted":{"at":"...","by":"user"},"approval":{"at":"...","by":"user","note":"看过了"},"completion":{"at":"...","by":"ai"},"voided":null,"history":[{"at":"...","by":"ai","action":"create","from":null,"to":"proposed","note":null}]}
```

| 层级 | 默认路径 | 含义 |
| --- | --- | --- |
| `global` | `<DSH_HOME>/todo/todos.jsonl` | 跨项目共享 |
| `project` | `<项目根>/.dsh/todo/todos.jsonl` | 只属于当前项目 |

项目根 = 从会话工作目录向上找最近的 `.git` / `.hg` / `.svn`；找不到就是会话工作目录本身（和 notepad 一样**不**把 `.dsh` 当标记，否则主目录下的任何路径都会被判成项目根、项目待办静默混进全局文件）。

写入路径：单条新增/状态变更都是**先写 `.tmp` 再 rename** 的整文件原子重写；同一进程内**按文件绝对路径**共享一把 promise 队列（不是按 store 实例），所以两个 store 指向同一个文件也不会互相插入半行。`maxTodos` 裁剪时**先丢最旧的已结束（done/void）条目**，正在进行中的工作不会被挤掉。

`updatedAt` / `at` 之外，每次状态变更都会往 `history` 追加 `{at, by, action, from, to, note}`，默认保留 50 条且**永远保留第一条**（起点记录）。

## 配置项（`Config`）

写在补丁条目的 `config:` 下，或由设置界面编辑（schema 已随插件导出）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `level` | `global` \| `project` \| `both` | `both` | 本部署暴露哪些层级 |
| `defaultScope` | `global` \| `project` | `project` | 调用省略 `scope` 时的落点 |
| `dshHome` | string | `''` | 全局层根目录；空 = `$DSH_HOME`，再退到 `~/.dsh` |
| `globalDir` | string | `''` | 覆盖全局目录（支持 `~`），空 = `<dshHome>/todo` |
| `projectDir` | string | `''` | 覆盖项目目录（支持 `~`），空 = `<项目根>/.dsh/todo` |
| `fileName` | string | `todos.jsonl` | 待办文件名（只接受纯文件名） |
| `projectRootMarkers` | string[] | `['.git','.hg','.svn']` | 向上查找项目根的标记；显式给 `[]` 表示「工作目录就是项目根」 |
| `maxTodos` | integer | `2000` | 单文件上限，超出优先丢最旧的已结束条目；`0` = 不裁剪 |
| `maxTitleLength` | integer | `200` | 标题字符上限 |
| `maxDetailLength` | integer | `8000` | 说明 / 验收标准字符上限 |
| `maxHistory` | integer | `50` | 单条待办保留的历史条数；`0` = 全留 |
| `defaultLimit` | integer | `50` | 列表默认条数 |
| `toolPrefix` | string | `todo` | 工具名前缀（合法值才会被采纳） |
| `enableCommand` | boolean | `true` | 是否注册 `/todo` 命令 |
| `deliverRequests` | boolean | `true` | 面板是否可以把待办投递进某条会话（关掉后「交给 AI 完成」直接给可复制的提示词） |

```yaml
# 只要项目级待办（默认行为，显式写出来更清楚）
- insert:
    - id: todo
      name: ./plugins/todo/lib/index.js
      config:
        level: project
        defaultScope: project
        projectRootMarkers: ['.git']
```

## 与 notepad 的差异（为什么不能直接抄）

| 点 | notepad | 本插件 |
| --- | --- | --- |
| 数据模型 | 追加式笔记，几乎不改 | 有状态机的待办，需要原地改状态 + 审计 |
| 更新方式 | 追加 + 按 id 重写 | 每次变更整文件原子重写 + `history` 审计 |
| 并发 | 按 store 实例串行 | **按文件绝对路径**串行（两个 store 指向同一文件也安全） |
| 删除 | `notepad_clear` 清层 | **不作废、不删除**：`void` 保留记录，可 `reopen` |
| 面板窗口 | 一个中央面板 | 中央面板 + **会话作用域桥接**（投递请求需要 `sessionId`） |
| 工具数 | 3 | 8（一个动作一个工具，模型不容易用错） |

## 验证

已在本机跑通的验证（DSH 运行时 `0.1.7-rc.2` / Node 24.21.0）：

```powershell
# 1) 单元测试
cd todo; & $node --test

# 2) 端到端冒烟：真 Cordis + 真 dsh-tools 注册表 + 真面板 API
& $node scripts\smoke-runtime.mjs

# 3) 真 loader：装进一个临时 profile，dump 组合结果与 Config schema
& $node scripts\install-todo.mjs --profile <某临时 profile>
& $node <dsh>\lib\bin.js --profile <某临时 profile> --dump-config-schema
```

结果摘要：

- `node --test`：**156/156 通过**（7 个文件）：
  - `test/store.test.js` — 路径/层级解析、JSONL 读写健壮性（坏行、截断行、缺字段）、批量校验先于落盘、
    列表排序与过滤、`counts` 口径、`locate`/`get` 按 id 前缀路由、状态机每个动作的合法与拒绝路径、历史裁剪、
    `maxTodos` 先丢已结束条目、**两条并发断言**（同一 store 实例 20 个并发创建、两个 store 指向同一文件）、
    `clear`、`availableActions`/`needsAttention`/`summarize`、注入时钟。
  - `test/api.test.js` — 会话栅栏 401/403、标记头 403、项目解析优先级（手动 > 会话 > 最近项目 > cwd）、
    state 形状与「只返回摘要」、`limit`/`status` 参数、`/todo` 404、`/prompt` 内容、POST `/todos` 以用户身份创建、
    POST `/action` **永远以用户身份执行（请求体里的 `actor` 被忽略）**、`/request` 的 409 两条降级与成功投递后置为 `working`。
  - `test/plugin.test.js` — `resolveOptions` 默认值与非法 `toolPrefix` 回退、`renderTodos`/`renderClaim` 文案、
    `/todo` 命令四种用法、`deliverToAgent` 的各种降级。
  - `test/client.test.js` — bundle 注册 id 与样式认领、三处 slot 注册（`main` 的 key 必须等于 `panellist` 的 id）、
    会话桥接把 `sessionId` 映射成 `cwd`、下拉选项必含当前项目、纯函数（`matchesFilter`/`actionLabel`/`mergeLevel`）、
    **带数据的真实渲染**（桩 React 维护 hook 状态并重渲染，断言标题/状态标签/`确认接受`/`交给 AI 完成` 等按钮）。
  - `test/invariants.test.js` — 把 **8 状态 × 11 动作 × 2 执行者 = 176** 种组合全跑一遍，断言：
    模型永远不能 `accept`/`confirm`、只能在 `confirmed` 上 `complete`、任何到达 `done` 的待办都带用户确认记录、
    非法转换一律抛 `TodoError` 且**不产生半次写入**；外加 `availableActions('ai', …)` 永不宣传这些动作。
  - `test/markers.test.js` — 回归测试：`projectRootMarkers` 两处都会 trim，
    所以配置里写成 `' .git '` 也不会退化成"会话目录就是项目根"（否则仓库里的项目待办会静默落到全局）。
  - `test/targets.test.js` — 投递目标：`GET /sessions` 的 `canList`/`canCreate`/`sameProject`/query/limit/502 降级、
    记录上的 `projectRoot`、`POST /request` 的三种 target（`session` 用选中的那条而不是面板所在的那条、
    `new` 用待办自己的项目根或全局待办选的项目、相对路径 400、没有会话服务/建不出来/抛错时的 409 与提示词）、
    以及会话列表映射（subagent 过滤、标题 hint 与目录名兜底、limit 上限、服务缺失或抛错时返回 undefined）、
    `deliverToAgent` 优先 `sessionController.prompt` 并在其失败且存在实时 agent 时回退 `followup`、
    客户端选择器的纯函数（`targetOptions` 永不产生"值不在选项里"、`parseTarget`、`newSessionCwd`、`projectChoices`）。
- `smoke-runtime.mjs`：8 个工具在真注册表上注册成功；完整跑通
  `propose →（模型 accept 被拒）→ 用户 accept / reject → claim → update(question) → 用户 answer → submit →（模型 complete 被拒）→ 用户 confirm → 模型 complete`；
  另外覆盖用户直接加待办并标记完成、`void` 缺 `confirm`/缺 `reason` 被拒、`todo_get` 完整历史、
  `/todo` 命令、`deliverToAgent` 把请求作为 **user 角色消息**投递（含没有 agent / 没有注册表两种降级）、
  以及投递目标链路：`GET /sessions` 的 `sameProject` 标记、投给**选中的**会话、`target:'new'` 用待办自己的项目根建会话。
- **装进正在运行的桌面应用**（本机实测）：补丁写入后宿主热重载，
  `GET /api/todo/state`（带 `x-todo-client: 1`）返回 **401 + `content-type: application/json; charset=utf-8`** 和插件自己的文案
  `{"error":"unauthenticated: open the todo panel from the GUI (its browser session cookie is required)"}`；
  对照网关自己的 `/api/zzz-unknown` 返回的 401 **没有 content-type**，两者可区分 —— 证明宿主半已挂载、路由已注册（工具注册发生在路由注册之前）。
- **真 loader（临时 profile + 与 desktop 相同的 bundle 栈）**：`--dump-config-schema` 里出现了
  `if name == file:///.../plugins/todo/lib/index.js then config $ref #/$defs/config99`，
  且 `config99.properties.level.description` 正是本插件的文案 —— 模块在真实进程里 import 成功、Config schema 可投影（即条目已挂载而不是 `inactive`）。验证用的临时 profile 已删除。
- **安装脚本**：profile 级与 home 级都验证过（home 级写的是绝对 `file://` 名称）；重复安装报 `patch already up to date`；`--uninstall` 后补丁回到 `[]`、插件目录删除。
- **浏览器半**：`todo/test/client.test.js` 用桩 `window.__ModuleLoader__` + 桩 React 装了整套面板，
  断言了注册 id/样式认领/三处 slot 注册（含 `main` 的 key 必须等于 `panellist` 的 id）/会话桥接把 `sessionId` 映射成 `cwd`/
  下拉选项必含当前项目/带数据的渲染结果。**图标要出现仍需重启一次应用**（新增浏览器半被 clientModules 进程级缓存）。

## 开发

```powershell
# 让本仓库的 bare import（@deepseek-ai/schemastery、@deepseek-ai/dsh-tools、@deepseek-ai/dsh-llm）能解析
powershell -File scripts\dev-link.ps1
cd todo; & $node --test
```

该脚本只在 `node_modules/@deepseek-ai` 建一个指向 `$DSH_HOME/profiles/node_modules/@deepseek-ai` 的 junction，不复制、不安装任何包。插件装进 profile 后不依赖它。

## 卸载

```powershell
& $node scripts\install-todo.mjs --profile desktop --uninstall   # 或 --scope home --uninstall
```

删除 `<...>/plugins/todo/` 与补丁文件中被标记包围的那段；原有的注释和其他条目（包括 notepad 的区块）原样保留。
