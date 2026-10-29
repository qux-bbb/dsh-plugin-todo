# dsh-plugin-todo

[![npm](https://img.shields.io/npm/v/@qux-bbb/dsh-plugin-todo)](https://www.npmjs.com/package/@qux-bbb/dsh-plugin-todo)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

DeepSeek Harness（DSH）的待办清单插件：**AI 可以提待办、认领、提交，但只有你能确认完成。**

## 安装

```sh
# 用 DSH 自带的插件命令（npm 包自带 dsh.bundle，无需手写路径）
dsh plugin --profile desktop add @qux-bbb/dsh-plugin-todo
```

从源码或离线安装时，用仓库里的安装器（只用 Node 内置模块，不需要 `npm install`）：

```powershell
git clone https://github.com/qux-bbb/dsh-plugin-todo.git
cd dsh-plugin-todo

# 用 DSH 自带的 node，不必单独装 Node
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts\install-todo.mjs --profile desktop
```

它会：① 把 `todo/` 拷到 `<profile>/plugins/todo`；② 在 `<profile>/cordis.patch.yml` 写入一段带首尾标记的托管条目。

装完**重启一次应用**（浏览器半随宿主启动加载）。前置条件：DSH 至少启动过一次。

常用参数：

| 参数 | 作用 |
|---|---|
| `--profile <name>` | 装到哪个 profile，默认 `desktop` |
| `--scope home` | 装到 `$DSH_HOME/plugins/todo`，所有 profile 生效 |
| `--level both\|global\|project` | 启用哪些待办层级，默认 `both` |
| `--default-scope global\|project` | 不写 `scope` 时的默认层级，默认 `project` |
| `--dry-run` / `--verify` | 只预览 / 用真实 loader 校验条目 |

> `# >>> dsh-plugin-todo >>>` 与 `# <<< dsh-plugin-todo <<<` 之间的内容每次安装都会被整段重写，你自己的 patch 条目要写在标记**外面**。

## 使用

- 模型工具：`todo_propose` `todo_list` `todo_get` `todo_claim` `todo_update` `todo_submit` `todo_void`
- 人类命令：`/todo [add <标题> | done <id> | show <id>]`
- 面板：侧边栏「待办」，跟随当前会话所在项目；可筛选、搜索、手动添加、看/改详情、行内操作（作废、打回重做）
- 「交给 AI 完成」把待办投递到某条会话（含新建、冷会话）；已经交给 AI 的用「重开待办」退回队列
- 归档后的待办仍可编辑补正，状态不变；「改状态」只列服务端允许的目标
- 存储：`<DSH_HOME>/todo/todos.jsonl`（全局）、`<项目根>/.dsh/todo/todos.jsonl`（项目）

## 更新

按当初的安装方式选一条，装完都重启应用。

**脚本安装的**：重跑同一个脚本即可，先拿到新代码——有 git 就 `git pull`，没有就下载新 ZIP 解压，再到新目录里执行：

```powershell
git pull
& $node scripts\install-todo.mjs --profile desktop
```

> 托管条目每次都会按**这次传的参数**重写 `level` / `defaultScope`，所以改过层级的话要带上同样的参数；`--scope home` 装的要带 `--scope home`，否则会在 profile 里再装一份。

**npm 安装的**：直接装最新版，或在「插件」页卸载后重装（desktop profile 需先完全退出应用）：

```sh
dsh plugin --profile desktop add @qux-bbb/dsh-plugin-todo@latest
```

## 卸载

```powershell
& $node scripts\install-todo.mjs --profile desktop --uninstall
```

只删它自己那段托管条目和拷贝进去的文件，同一文件里属于你的其他条目与注释都保留。

## 开发

```powershell
powershell -File scripts\dev-link.ps1   # 链接 DSH 运行时包，仅本地跑测试用
cd todo; node --test                    # 单元测试
node scripts\smoke-runtime.mjs          # 端到端冒烟
```

`dev-link.ps1` 是 Windows 专用（建目录 junction），且要求 DSH 已启动过一次；Linux/macOS 手工软链等价：

```bash
ln -s "$DSH_HOME/profiles/node_modules/@deepseek-ai" node_modules/@deepseek-ai
ln -s "$DSH_HOME/profiles/node_modules/react" node_modules/react
ln -s "$DSH_HOME/profiles/node_modules/react-dom" node_modules/react-dom
```

只有跑测试需要这一步，**装插件本身不需要**。

版本变更见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。
