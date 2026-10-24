# dsh-plugin-todo

一个 DeepSeek Harness（DSH）插件：**人和 AI 协作的待办清单，所有"确认"都留在人手里**。

AI 提的待办要等你确认才算数；AI 做完只能提交"待确认"，**你确认即完成**——模型没有任何路径自己把待办标成完成。规则写在 `lib/store.js` 里。

```
AI propose → proposed ─用户 accept→ open ─AI claim→ working ─AI submit→ review
            └用户 reject→ void                        └用户 confirm→ done
```

版本记录与各版本变更见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

## 安装

### 第一次装（含另一台机器）

```powershell
git clone https://github.com/qux-bbb/dsh-plugin-todo.git
cd dsh-plugin-todo

# 用 DSH 自带的 node 跑安装脚本，不必单独装 Node
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts\install-todo.mjs --profile desktop
```

那台机器上没有 git 的话，在 GitHub 页面 Code → Download ZIP 解压即可，脚本只需要这个目录。

**前置条件：DSH 至少启动过一次**——`$DSH_HOME`（默认 `~/.dsh`）、`profiles\<name>` 目录和自带的 node 运行时都是那时建好的。安装脚本只用 Node 内置模块，**不需要 `npm install`**。它做两件事：

1. 把 `todo/` 拷进 `<profile>/plugins/todo`（**不含 `test/`**）
2. 在 `<profile>/cordis.patch.yml` 写入一段带首尾标记的托管条目

装完 **重启一次应用**：宿主半会热重载，但浏览器半是随宿主启动加载的。

### 参数

| 参数 | 作用 |
|---|---|
| `--profile <name>` | 装到哪个 profile，默认 `desktop`；填你实际在跑的那个 |
| `--level both\|global\|project` | 暴露哪几种待办层级，默认 `both` |
| `--default-scope global\|project` | 调用不写 `scope` 时用哪层，默认 `project` |
| `--scope home` | 装到 `$DSH_HOME/plugins/todo`，**所有 profile 都生效**（此时 patch 里写的是绝对 `file://` 路径） |
| `--dry-run` | 只打印打算写的文件，不动磁盘 |
| `--verify` | 调真实 loader 的 `--dump-config` 校验条目；`desktop` 会被主动跳过，其他 profile 必须已被 harness 注册 |
| `--uninstall` | 卸载 |

（下面的 `$node` 沿用上面那个自带运行时的定义；换成 `node` 也可以，只要版本够新。）

```powershell
& $node scripts\install-todo.mjs --profile desktop --scope home            # 全局生效
& $node scripts\install-todo.mjs --profile desktop --default-scope global  # 改默认层级
& $node scripts\install-todo.mjs --profile desktop --dry-run               # 只预览
```

### 更新

```powershell
git pull
& $node scripts\install-todo.mjs --profile desktop
```

然后重启应用。脚本**先写文件、最后写 patch**，这样 watching 的宿主不会看到一个指向不存在文件的条目。

### 卸载

```powershell
& $node scripts\install-todo.mjs --profile desktop --uninstall
```

只删它自己那段托管条目和拷贝进去的文件；同一文件里属于你的其他条目与注释都保留。

### 装完没生效？

1. **重启应用** —— 只刷新页面可能还是旧的浏览器半。
2. 条目仍是 `status: inactive` —— 把某个 config 值改一次再改回来（例如 `--default-scope global` 再改回 `project`），或者重启：宿主不会重试**未发生变化**的 inactive 条目。
3. 还不行就 `--dry-run` 看它打算写什么，再核对 `<profile>/cordis.patch.yml` 里有没有 `id: todo`。

### ⚠️ 别往托管标记中间塞东西

`# >>> dsh-plugin-todo (...) >>>` 与 `# <<< dsh-plugin-todo <<<` 之间的内容**每次重装都会被整段重写**。你自己的 patch 条目（例如 `permission-presets`）要写在标记**外面**，否则重装时会连同它一起被删掉。

## 使用

- 工具：`todo_propose` `todo_list` `todo_get` `todo_claim` `todo_update` `todo_submit` `todo_void`，另有 `/todo` 命令
- 面板：侧边栏「待办」，跟随当前会话所在项目；筛选、搜索、手动添加、看/改详情、行内操作
- 「交给 AI 完成」可选投递到哪条会话（含新建会话），冷会话也能投
- 存储：`<DSH_HOME>/todo/todos.jsonl`（全局）、`<项目根>/.dsh/todo/todos.jsonl`（项目）；配置项见 `lib/index.js` 的 `Config`

## 开发

```powershell
powershell -File scripts\dev-link.ps1   # 链接 @deepseek-ai/* 到本仓库，仅为本地跑测试
cd todo; node --test                    # 165 个单元测试
node scripts\smoke-runtime.mjs          # 端到端冒烟
```

`dev-link.ps1` 是 Windows 专用（建目录 junction），且要求 DSH 已经跑过一次；Linux/macOS 上等价做法是手工软链：

```bash
mkdir -p node_modules
ln -s "$DSH_HOME/profiles/node_modules/@deepseek-ai" node_modules/@deepseek-ai
ln -s "$DSH_HOME/profiles/node_modules/react" node_modules/react
ln -s "$DSH_HOME/profiles/node_modules/react-dom" node_modules/react-dom
```

只有跑测试/冒烟需要这一步；**装插件本身不需要**。

MIT
