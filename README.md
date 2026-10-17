# dsh-plugin-todo

一个 DeepSeek Harness（DSH）插件：**人和 AI 协作的待办清单，所有"确认"都留在人手里**。

AI 提的待办要等你确认才算数；AI 做完只能提交"待确认"，你确认之后才能标记完成。规则写在 `lib/store.js` 里。

```
AI propose → proposed ─用户 accept→ open ─AI claim→ working ─AI submit→ review
            └用户 reject→ void                        └用户 confirm→ confirmed ─AI complete→ done
```

## 安装

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts\install-todo.mjs --profile desktop              # 装到 desktop profile；--scope home 装到全局
& $node scripts\install-todo.mjs --profile desktop --uninstall  # 卸载
```

宿主半热重载生效；**新增浏览器半需要重启一次应用**。

## 使用

- 工具：`todo_propose` `todo_list` `todo_get` `todo_claim` `todo_update` `todo_submit` `todo_complete` `todo_void`，另有 `/todo` 命令
- 面板：侧边栏「待办」，跟随当前会话所在项目；筛选、搜索、手动添加、看/改详情、行内操作
- 「交给 AI 完成」可选投递到哪条会话（含新建会话），冷会话也能投
- 存储：`<DSH_HOME>/todo/todos.jsonl`（全局）、`<项目根>/.dsh/todo/todos.jsonl`（项目）；配置项见 `lib/index.js` 的 `Config`

## 开发

```powershell
powershell -File scripts\dev-link.ps1   # 链接 @deepseek-ai/* 到本仓库，仅为本地跑测试
cd todo; node --test                    # 156 个单元测试
node scripts\smoke-runtime.mjs          # 端到端冒烟
```

MIT
