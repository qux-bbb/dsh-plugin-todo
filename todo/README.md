# @qux-bbb/dsh-plugin-todo

[![npm](https://img.shields.io/npm/v/@qux-bbb/dsh-plugin-todo)](https://www.npmjs.com/package/@qux-bbb/dsh-plugin-todo)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

DeepSeek Harness（DSH）插件包：一个**由用户确认**的待办清单——AI 提的待办要等你接受才算数，AI 做完只能提交"待确认"，**你确认即完成**，模型没有任何路径自己把待办标成完成。

```
AI propose → proposed ─用户 accept→ open ─AI claim→ working ─AI submit→ review
            └用户 reject→ void                        └用户 confirm→ done
```

## 安装

包声明了 `dsh.bundle`，所以它是一个**组合包**（bundle）：装进 profile 后，`cordis.patch.yml` 这一层会按包名自动激活，无需手写路径。

```sh
# 需要带 `dsh plugin` 命令的 DSH
dsh plugin --profile desktop add @qux-bbb/dsh-plugin-todo
```

不走 `dsh plugin` 时，用仓库自带的手动安装器（把包装进 profile，并写入受标记保护的 patch 区块）：

```powershell
git clone https://github.com/qux-bbb/dsh-plugin-todo.git
cd dsh-plugin-todo
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts\install-todo.mjs --profile desktop
```

装完**重启一次应用**（浏览器半随宿主启动加载）。

## 功能

- 模型工具：`todo_propose` / `todo_list` / `todo_get` / `todo_claim` / `todo_update` / `todo_submit` / `todo_void`
- 人类命令：`/todo [add <标题> | done <id> | show <id>]`
- 面板：侧边栏「待办」图标 + 中央 `main` 页面，3 个筛选分组（待我处理 / 进行中 / 全部）、搜索、手动添加、查看/编辑详情、行内操作（点「作废」「打回重做」「回答」会直接在该行展开原因/回答框，不用先展开详情）；标题下方「项目待办」直接列出每个项目与全局各有多少条待办（含待你处理数），点一下切换项目或全局
- 「交给 AI 完成」只在 `open`（待办）时出现；已经交给 AI 的 `working` / `blocked` 用「重开待办」退回队列（`open`）再重新交付，重开会清掉认领与 AI 的提问。可选投递到哪条会话（`当前会话` / `新建会话` / 其他会话；冷会话也能投），全局待办还能选项目
- 归档后仍可维护：`done` / `void` 的待办可在展开详情里「编辑待办」原地补充/修正（状态不变，`approval` / `completion` / `voided` 保留）；「改状态」下拉只列服务端允许的目标（例如 `done` / `void` → `open`），选中即执行对应动作
- 存储：明文 JSON Lines，一层一个文件——`global` = `$DSH_HOME/todo/todos.jsonl`，`project` = `<项目根>/.dsh/todo/todos.jsonl`

## 两条不可绕过的规则

由 `lib/store.js` 的状态机强制，宿主半与浏览器半共用同一份代码：

1. `proposed → open` 只能由**用户**在面板里 `accept`；模型不能确认自己提出的待办。
2. `done` 必须有用户确认记录，而且**只有用户能收尾**：模型最多 `todo_submit` 把待办交到 `review`，没有任何动作能让它变成 `done`；用户 `review` 上用 `confirm`（确认即完成）或对未提交的待办用 `complete`，这两个动作本身就是确认，会写进 `approval`。

## 链接

- 仓库与完整文档：<https://github.com/qux-bbb/dsh-plugin-todo>
- 更新日志：<https://github.com/qux-bbb/dsh-plugin-todo/blob/main/docs/CHANGELOG.md>
- 许可证：[MIT](LICENSE)
