/**
 * Todo browser half.
 *
 * This is a hand-written DSH client bundle: a classic script (not a module, no
 * build step) that only registers a factory. The module system runs the factory
 * on first use, claims the stylesheet it inserts synchronously, and treats the
 * returned `{ apply, inject }` as a Cordis client plugin.
 *
 * The panel is a pair of registrations coupled by one string: an icon in
 * `sidebar.panellist` (id `todo`) and the center page in the keyed `main` slot
 * (key `todo`). All data lives behind the host half's own HTTP route under
 * `api/todo` (document-relative on purpose, matching the shipped client-hmr
 * half).
 *
 * The panel is where the two confirmations live: accepting a todo the model
 * proposed, and confirming a result the model submitted. It is also the only
 * place that can hand a todo to the model ("交给 AI"), which the host delivers
 * into the current session as a user message.
 *
 * @see module:dsh-plugin-todo
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-todo',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Panel key shared by the sidebar icon and the center page. */
    const PANEL_ID = 'todo'
    /** Host route prefix, document-relative so a non-root mount still works. */
    const API = 'api/todo'
    /** Marker header the host API requires; a cross-site request cannot set it. */
    const CLIENT_HEADER = 'x-todo-client'

    /**
     * Status presentation: how one todo explains its own state. The row badge,
     * not a filter tab, is what names the status — one tab per status turned the
     * toolbar into a row of mostly-empty buttons, and a status covered by two
     * tabs showed up twice. One entry per status; the state machine has seven.
     */
    const STATUS_META = {
      proposed: { label: '待你接受', hint: 'AI 提出的待办，需要你确认后才生效' },
      review: { label: '待你确认', hint: 'AI 说做完了，你确认即完成' },
      blocked: { label: '待你补充', hint: 'AI 缺信息，等你回答' },
      working: { label: 'AI 进行中', hint: 'AI 正在处理' },
      open: { label: '待办', hint: '还没开始' },
      done: { label: '已完成', hint: '已完成' },
      void: { label: '已作废', hint: '已作废' },
    }
    /**
     * The filter tabs, in order. A tab bundles several statuses so the toolbar
     * stays at three buttons; `statuses: null` means "everything".
     */
    const FILTER_GROUPS = [
      {
        id: 'attention',
        label: '待我处理',
        hint: '待你接受 · 待你确认 · 待你补充 — 只有你能推进的',
        statuses: ['proposed', 'review', 'blocked'],
      },
      {
        id: 'progress',
        label: '进行中',
        hint: '待办 · AI 进行中 — 还在流转，暂时不需要你操作',
        statuses: ['open', 'working'],
      },
      {
        id: 'all',
        label: '全部',
        hint: '当前范围内所有待办，含已完成与已作废',
        statuses: null,
      },
    ]
    /** The filter tabs, in order. */
    const FILTERS = FILTER_GROUPS.map((group) => group.id)
    /** Tabs by id, for label / hint / status lookup. */
    const GROUP_BY_ID = new Map(FILTER_GROUPS.map((group) => [group.id, group]))
    /** Priority presentation. */
    const PRIORITY_META = {
      high: { label: '高', marker: '!!' },
      normal: { label: '中', marker: '' },
      low: { label: '低', marker: '·' },
    }
    /** Action button labels; `reject` reads differently per status. */
    const ACTION_LABELS = {
      accept: '确认接受',
      request: '交给 AI 完成',
      answer: '回答',
      confirm: '确认完成',
      complete: '标记完成',
      // The detail form edits the whole todo (title, detail, acceptance,
      // priority, tags), so the label names the todo, not its detail section.
      update: '编辑待办',
      void: '作废',
      reopen: '重新打开',
    }
    /** Actions that destroy or complete something, so they render as danger buttons. */
    const DANGER_ACTIONS = ['void', 'reject']
    /** Actions the row renders as a primary call to action. */
    const PRIMARY_ACTIONS = ['accept', 'confirm', 'request', 'complete']

    const CSS = `
.todoPage{box-sizing:border-box;height:100%;overflow:auto;padding:18px 22px 28px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:20px}
.todoHead{display:flex;flex-direction:column;gap:10px}
.todoTitleRow{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.todoTitle{font-size:15px;font-weight:600}
.todoMeta{color:var(--dsw-alias-label-caption,#8b949e);font-size:11px;line-height:16px}
.todoToolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.todoTabs{display:inline-flex;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:8px;overflow:hidden;flex-wrap:wrap}
.todoTab{border:0;background:0 0;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;padding:5px 10px;cursor:pointer;white-space:nowrap}
.todoTab[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2328);font-weight:500}
.todoTab:disabled{opacity:.4;cursor:default}
.todoCount{border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));padding:0 5px;margin-left:4px;font-size:10px}
.todoInput,.todoTextarea,.todoSelect{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));color:inherit;font:inherit;padding:6px 9px;outline:none;min-width:0}
.todoInput:focus,.todoTextarea:focus{border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.6))}
.todoTextarea{resize:vertical;min-height:56px;width:100%}
.todoGrow{flex:1}
.todoButton{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:8px;background:0 0;color:inherit;font:inherit;padding:4px 10px;cursor:pointer;white-space:nowrap}
.todoButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.todoButton:disabled{opacity:.5;cursor:default}
.todoButton[data-primary=true]{border-color:var(--dsw-alias-label-primary,#1f2328);font-weight:500}
.todoButton[data-danger=true]:hover:not(:disabled){background:var(--dsw-alias-state-error-primary,rgba(207,34,46,.12))}
.todoComposer{display:flex;flex-direction:column;gap:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:10px;padding:10px}
.todoList{display:flex;flex-direction:column;gap:8px}
.todoItem{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:10px;padding:9px 12px;display:flex;flex-direction:column;gap:6px}
.todoItem[data-attention=true]{border-color:var(--dsw-alias-state-warning-primary,rgba(191,135,0,.55))}
.todoItem[data-expanded=true]{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04))}
.todoItemHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer}
.todoItemTitle{font-weight:500;word-break:break-word}
.todoItemTitle[data-done=true]{text-decoration:line-through;color:var(--dsw-alias-label-caption,#8b949e)}
.todoBadge{border-radius:999px;padding:1px 8px;font-size:11px;white-space:nowrap;border:.5px solid currentColor}
.todoPriority{font-size:11px;color:var(--dsw-alias-label-caption,#8b949e)}
.todoTag{border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a)}
.todoActions{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
.todoDetail{display:flex;flex-direction:column;gap:8px;border-top:.5px dashed var(--dsw-alias-border-l3,rgba(127,127,127,.35));padding-top:8px}
.todoField{display:flex;flex-direction:column;gap:3px}
.todoFieldLabel{font-size:11px;color:var(--dsw-alias-label-caption,#8b949e)}
.todoFieldValue{white-space:pre-wrap;word-break:break-word}
.todoTimeline{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a)}
.todoState{color:var(--dsw-alias-label-caption,#8b949e);font-size:12px}
.todoNotice{color:var(--dsw-alias-state-success-primary,#1a7f37);font-size:12px;white-space:pre-wrap}
.todoError{color:var(--dsw-alias-state-error-primary,#cf222e);font-size:12px;white-space:pre-wrap}
.todoPath{color:var(--dsw-alias-label-caption,#8b949e);font-size:11px;word-break:break-all}
.todoPromptDraft{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:8px;padding:8px}
`

    // Styles must be inserted synchronously while the factory runs: the module
    // system claims any untagged <style> present when it returns, and removes it
    // again on hot reload or disable.
    const CSS_TAG = 'dsh-plugin-todo/client.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) === null) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-plugin-todo'
      style.dataset.pluginCss = CSS_TAG
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /**
     * Call one host API route.
     * @param {string} method - HTTP method.
     * @param {string} path - route path below the API prefix.
     * @param {object} [body] - JSON request body.
     * @returns {Promise<object>} the parsed response payload.
     */
    async function call(method, path, body) {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = {}
      }
      if (!response.ok) {
        const failure = new Error(payload?.error ?? `${method} ${path} failed with ${response.status}`)
        // A refused hand-off still answers with the prepared prompt.
        failure.prompt = typeof payload?.prompt === 'string' ? payload.prompt : undefined
        throw failure
      }
      return payload
    }

    /** Merge one level's fresh payload into the panel state. */
    function mergeLevel(state, payload) {
      return { ...state, levels: { ...state.levels, [payload.scope]: payload } }
    }

    /** One level's todo count, tolerating a disabled level. */
    function totalOf(state, scope) {
      return state?.levels?.[scope]?.enabled === true ? state.levels[scope].total : 0
    }

    /** The status counts of one level. */
    function countsOf(state, scope) {
      return state?.levels?.[scope]?.counts ?? {}
    }

    /** The statuses one filter tab covers, or `null` for "everything". */
    function statusesOf(filter) {
      return GROUP_BY_ID.get(filter)?.statuses ?? null
    }

    /** The number of todos one filter tab covers, from the server counts. */
    function countOf(state, scope, filter) {
      if (filter === 'all') return totalOf(state, scope)
      const wanted = statusesOf(filter)
      if (wanted === null) {
        return countsOf(state, scope)[filter] ?? 0
      }
      const counts = countsOf(state, scope)
      return wanted.reduce((sum, status) => sum + (counts[status] ?? 0), 0)
    }

    /** The number of todos waiting for a human decision. */
    function attentionOf(state, scope) {
      return countOf(state, scope, 'attention')
    }

    /**
     * Whether a todo is waiting for the user right now. The server decides it
     * once in `summarize`; the panel only reads the flag, so a new status can
     * never leave the row highlight behind.
     * @param {{ attention?: boolean }} todo - a todo row from the panel API.
     * @returns {boolean} true when the server marked it as needing the user.
     */
    function isAttention(todo) {
      return todo?.attention === true
    }

    /** Whether one todo passes the current filter. */
    function matchesFilter(todo, filter) {
      if (filter === 'all') return true
      const wanted = statusesOf(filter)
      if (wanted !== null) return wanted.includes(todo.status)
      // An ungrouped value is a plain status name: a single status stays
      // filterable even though no tab is dedicated to it any more.
      return todo.status === filter
    }

    /** The button label of one action on one todo. */
    function actionLabel(todo, action) {
      if (action === 'reject') return todo.status === 'review' ? '打回重做' : '驳回'
      return ACTION_LABELS[action] ?? action
    }

    /**
     * One labelled form control. Both forms the panel renders (manual add and
     * edit) put their field name in a visible <label> tied to the control: a
     * placeholder is gone as soon as the box has content, and the edit form
     * opens with content already in every box.
     * @param {string} id - the control's id, also the label's `for`.
     * @param {string} label - the visible field name.
     * @param {object} control - the input / textarea / select element.
     * @param {string} [extraClass] - extra class on the wrapping row.
     * @returns {object} the field row.
     */
    function labelledField(id, label, control, extraClass) {
      return h('div', { className: extraClass === undefined ? 'todoField' : `todoField ${extraClass}` },
        h('label', { className: 'todoFieldLabel', htmlFor: id }, label),
        control)
    }

    /** The last path segment of a directory path, for labels. */
    function folderName(path) {
      return String(path ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(path ?? '')
    }

    /**
     * The project dropdown's entries: every registered workspace, plus the project
     * the panel is actually addressing when it is not registered. A `<select>`
     * whose `value` matches no option silently displays the first option instead,
     * which would name a different project than the one being edited.
     * @param {Array<{ path: string, title?: string }>} projects - registered workspaces.
     * @param {string | null} current - the project this panel is addressing.
     * @returns {Array<{ path: string, title: string, followed: boolean }>} dropdown entries.
     */
    function projectOptions(projects, current) {
      const entries = projects.map((entry) => ({ path: entry.path, title: entry.title || entry.path, followed: false }))
      if (current !== null && current !== undefined && current !== '' && !entries.some((entry) => entry.path === current)) {
        entries.unshift({ path: current, title: `${folderName(current)}（当前会话）`, followed: true })
      }
      return entries
    }

    /** The picker value that addresses one session. */
    function sessionTargetValue(sessionId) {
      return `session:${sessionId}`
    }

    /** Turn one picker value into the request's `target` fields. */
    function parseTarget(value) {
      if (value === 'new') return { target: 'new' }
      if (typeof value === 'string' && value.startsWith('session:')) return { target: 'session', sessionId: value.slice('session:'.length) }
      return { target: 'current' }
    }

    /**
     * The label of one session in the hand-off picker: its title, plus the facts
     * that decide the choice (same project, already running, needs resuming).
     * @param {object} session - one host session row.
     * @returns {string} the label.
     */
    function sessionLabel(session) {
      const parts = [session.title || session.id]
      if (session.sameProject === true) parts.push('同项目')
      if (session.running === true) parts.push('运行中')
      if (session.agentAvailable !== true) parts.push('需恢复')
      return parts.join(' · ')
    }

    /**
     * Order the listed sessions newest activity first.
     *
     * The panel API already promises this order; sorting again here keeps the
     * picker correct while a reloaded host half is paired with a browser half
     * that still holds an older payload, and makes "the session I just created"
     * the first pickable row rather than the last. The sort is stable, so rows
     * without a usable timestamp keep the order they arrived in.
     * @param {Array<object>} sessions - sessions from the panel API.
     * @returns {Array<object>} the same rows, newest first.
     */
    function byRecency(sessions) {
      const stamp = (session) => (typeof session?.updatedAt === 'number' ? session.updatedAt : 0)
      return [...sessions].sort((left, right) => stamp(right) - stamp(left))
    }

    /**
     * Every choice the picker offers. The current value is always present: a
     * `<select>` whose value matches no option silently shows the first one, and
     * that would hand the todo to a conversation the user did not pick.
     * @param {object} input - option input.
     * @param {string | null} input.currentId - the session the panel is in.
     * @param {string} [input.currentTitle] - that session's title, when known.
     * @param {Array<object>} [input.sessions] - sessions from the host.
     * @param {boolean} [input.canCreate] - whether a new session can be created.
     * @returns {Array<{ value: string, label: string, title?: string, disabled?: boolean }>} the options.
     */
    function targetOptions({ currentId, currentTitle, sessions = [], canCreate = false }) {
      const options = [{
        value: 'current',
        label: currentTitle ? `当前会话（${currentTitle}）` : '当前会话',
        disabled: currentId === null || currentId === undefined,
      }]
      if (canCreate === true) options.push({ value: 'new', label: '新建会话' })
      for (const session of byRecency(sessions)) {
        if (currentId !== null && currentId !== undefined && session.id === currentId) continue
        options.push({ value: sessionTargetValue(session.id), label: sessionLabel(session), title: session.cwd ?? session.id })
      }
      return options
    }

    /**
     * The projects the picker can address: registered workspaces, the project the
     * panel is showing, and every project the listed sessions live in — so a
     * global todo can be handed to a project the user never opened here.
     * @param {object} input - choice input.
     * @param {Array<{ path: string, title?: string }>} [input.projects] - registered workspaces.
     * @param {string} [input.currentRoot] - the panel's project root.
     * @param {Array<object>} [input.sessions] - sessions from the host.
     * @returns {Array<{ path: string, title: string }>} the choices.
     */
    function projectChoices({ projects = [], currentRoot, sessions = [] }) {
      const entries = []
      const seen = new Set()
      const push = (path, title) => {
        if (typeof path !== 'string' || path.length === 0 || seen.has(path)) return
        seen.add(path)
        entries.push({ path, title: title || path })
      }
      for (const project of projects) push(project.path, project.title)
      if (typeof currentRoot === 'string' && currentRoot.length > 0) push(currentRoot, `${folderName(currentRoot)}（当前项目）`)
      for (const session of sessions) {
        if (typeof session.projectRoot === 'string' && session.projectRoot.length > 0) push(session.projectRoot)
      }
      return entries
    }

    /**
     * The working directory a newly created hand-off session should use.
     *
     * A project-level todo is bound to its own project, so its project root wins.
     * A global todo is not bound to one, so the user's pick in the picker
     * decides — including a hand-typed path when the project is not listed yet.
     * @param {{ scope: string }} todo - the todo being handed over.
     * @param {{ cwd?: string, manualCwd?: boolean }} picker - the picker state.
     * @param {{ projectRoot?: string } | null | undefined} record - the full todo record, when loaded.
     * @returns {string} the absolute working directory (may be empty when unknown).
     */
    function newSessionCwd(todo, picker, record) {
      if (todo.scope === 'project') {
        const root = record?.projectRoot
        if (typeof root === 'string' && root.length > 0) return root
      }
      const chosen = typeof picker.cwd === 'string' ? picker.cwd.trim() : ''
      return chosen
    }

    /**
     * The project filter to apply to the session list, or `null` for "every
     * project". Only a global todo offers this: a project todo's own project is
     * already the answer, while a global one has to say where to work.
     * @param {{ project?: string }} picker - the picker state.
     * @returns {string | null} the project root to keep.
     */
    function projectFilterOf(picker) {
      const value = picker.project
      return typeof value === 'string' && value.length > 0 && value !== '__all__' ? value : null
    }

    /** The sidebar panel icon (receives `{ size, active }`). */
    function TodoIcon({ size, active }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', style: { opacity: active ? 1 : 0.75 },
      },
      h('path', { d: 'M4.5 6.5l1.8 1.8L9.5 5' }),
      h('path', { d: 'M4.5 12.5l1.8 1.8L9.5 11' }),
      h('path', { d: 'M4.5 18.5l1.8 1.8L9.5 17' }),
      h('path', { d: 'M12 6.5h7.5M12 12.5h7.5M12 18.5h7.5' }))
    }

    /**
     * The session the page last showed, reported by the session-scoped bridge
     * below. Root-scoped panels receive no session id (neither `PanelInfo` nor
     * the sessions service exposes a "current" selection), so the bridge is how
     * the center page learns which project to open and which session to hand a
     * todo to. `cwd` is the session's own working directory — the same value the
     * model tools resolve against.
     */
    const activeSession = { id: null, cwd: null }

    /** Stand-in selector hook for a host that supplies no `useSessions`. */
    const useNoSessions = (selector) => selector({ byId: {} })

    /**
     * A zero-size registration in a session-scoped header slot whose only job is
     * to remember the current session and its working directory. It keeps the
     * last value after it unmounts (selecting the todo panel hides the
     * conversation), which is exactly the session the user was just looking at.
     */
    function TodoSessionBridge(props) {
      const sessionId = props?.sessionId ?? null
      const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : useNoSessions
      const cwd = useSessions((state) => (sessionId === null ? null : state?.byId?.[sessionId]?.cwd ?? null))
      React.useEffect(() => {
        activeSession.id = sessionId
        activeSession.cwd = cwd ?? null
      }, [sessionId, cwd])
      return h('span', { style: { display: 'none' }, 'aria-hidden': 'true' })
    }

    /** The todo list page: the model's tools and the `/todo` command share these files. */
    function TodoPage() {
      const [state, setState] = React.useState(null)
      const [scope, setScope] = React.useState('project')
      const [manual, setManual] = React.useState(null)
      const [filter, setFilter] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const [expanded, setExpanded] = React.useState(null)
      /** Full records, keyed by id, fetched on expand. */
      const [records, setRecords] = React.useState({})
      /** Inline editor draft, or null. */
      const [editing, setEditing] = React.useState(null)
      /** Inline answer / void-reason draft: `{ id, kind, text }`, or null. */
      const [promptDraft, setPromptDraft] = React.useState(null)
      /**
       * The hand-off target picker, or null. Which conversation a todo goes to is
       * the user's choice: the current one, any session the host lists, or a new
       * one (whose working directory a global todo also chooses).
       */
      const [picker, setPicker] = React.useState(null)
      /** The add form. */
      const [adding, setAdding] = React.useState(false)
      const [draft, setDraft] = React.useState({ title: '', detail: '', acceptance: '', tags: '', priority: 'normal' })
      /** A prompt the host refused to deliver, offered for copy/paste. */
      const [fallback, setFallback] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      /** Last state payload, readable from callbacks without re-creating them. */
      const stateFromRef = React.useRef(null)

      /**
       * The project this page addresses: the user's manual pick, else the
       * session's own cwd, else whatever the last state reported, else the most
       * recently updated registered workspace. Only `project` goes on the wire:
       * the route resolves it exactly like a tool call does.
       */
      const targetOf = React.useCallback((override) => {
        const chosen = override === undefined ? manual : override
        if (chosen !== null && chosen !== undefined && chosen !== '') return chosen
        if (activeSession.cwd !== null && activeSession.cwd !== '') return activeSession.cwd
        const known = stateFromRef.current
        if (known?.current?.path) return known.current.path
        return known?.projects?.[0]?.path ?? null
      }, [manual])

      const load = React.useCallback(async (override) => {
        setBusy(true)
        try {
          const target = targetOf(override)
          const hint = activeSession.id === null ? {} : { session: activeSession.id }
          const params = new URLSearchParams({ limit: '0', ...hint, ...(target === null ? {} : { project: target }) })
          const next = await call('GET', `/state?${params.toString()}`)
          stateFromRef.current = next
          setState(next)
          setScope((current) => (next.levels[current]?.enabled === true ? current : next.defaultScope))
          setError(null)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }, [targetOf])

      React.useEffect(() => { void load() }, [load])

      // Follow the session even while the page stays open: a session switch (or
      // the first report from the bridge) reloads against the new project.
      const observedSession = React.useRef(null)
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (manual !== null) return
          if (activeSession.id === observedSession.current) return
          observedSession.current = activeSession.id
          void load()
        }, 1500)
        return () => clearInterval(timer)
      }, [load, manual])

      /** The project and session every request carries. */
      const envelope = React.useCallback(() => {
        const target = targetOf()
        return {
          ...(target === null ? {} : { project: target }),
          ...(activeSession.id === null ? {} : { session: activeSession.id }),
        }
      }, [targetOf])

      /** Refresh the full record of one todo (the expanded row). */
      const loadRecord = React.useCallback(async (id) => {
        try {
          const payload = await call('GET', `/todo?${new URLSearchParams({ id, ...envelope() }).toString()}`)
          setRecords((current) => ({ ...current, [id]: payload.todo }))
          return payload.todo
        } catch (failure) {
          setError(failure.message)
          return null
        }
      }, [envelope])

      /**
       * Run one panel request; on success merge the level payload and refresh the
       * affected record. `keepPrompt` keeps the current inline draft open.
       */
      const mutate = async (method, path, body, { id, keepPrompt = false, message } = {}) => {
        setBusy(true)
        try {
          const payload = await call(method, path, { ...envelope(), ...body })
          setState((current) => (current === null ? current : mergeLevel(current, payload)))
          setError(null)
          setFallback(null)
          if (message !== undefined) setNotice(message)
          const targetId = id ?? payload?.todo?.id
          if (targetId !== undefined) await loadRecord(targetId)
          if (!keepPrompt) setPromptDraft(null)
          return payload
        } catch (failure) {
          setError(failure.message)
          if (failure.prompt !== undefined) setFallback({ id: id ?? body?.id, prompt: failure.prompt })
          return null
        } finally {
          setBusy(false)
        }
      }

      const toggleRow = async (todo) => {
        const next = expanded === todo.id ? null : todo.id
        setExpanded(next)
        setEditing(null)
        setPromptDraft(null)
        setFallback(null)
        setNotice(null)
        if (next !== null) await loadRecord(next)
      }

      const addTodo = async () => {
        if (draft.title.trim() === '') return
        const payload = await mutate('POST', '/todos', {
          scope,
          title: draft.title,
          detail: draft.detail,
          acceptance: draft.acceptance,
          priority: draft.priority,
          tags: draft.tags.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''),
        }, { message: '已添加到待办。' })
        if (payload !== null) {
          setDraft({ title: '', detail: '', acceptance: '', tags: '', priority: 'normal' })
          setAdding(false)
        }
      }

      const runAction = (todo, action, extra) => {
        if (action === 'update') {
          setEditing({
            id: todo.id,
            title: todo.title,
            detail: todo.detail ?? '',
            acceptance: todo.acceptance ?? '',
            tags: (todo.tags ?? []).join(', '),
            priority: todo.priority ?? 'normal',
          })
          setPromptDraft(null)
          return
        }
        if (action === 'answer') {
          setPromptDraft({ id: todo.id, kind: 'answer', text: '' })
          return
        }
        if (action === 'void') {
          setPromptDraft({ id: todo.id, kind: 'void', text: '' })
          return
        }
        if (action === 'request') {
          void openPicker(todo)
          return
        }
        if (action === 'reject' && todo.status === 'review') {
          setPromptDraft({ id: todo.id, kind: 'reject', text: '' })
          return
        }
        const label = actionLabel(todo, action)
        if (typeof window !== 'undefined' && (action === 'accept' || action === 'confirm')
          && !window.confirm(`${label}：${todo.title}？`)) return
        void mutate('POST', '/action', { id: todo.id, action, scope: todo.scope, ...(extra ?? {}) }, {
          message: `${label}：${todo.title}`,
        })
      }

      const submitPromptDraft = async () => {
        if (promptDraft === null) return
        const text = promptDraft.text.trim()
        if (promptDraft.kind !== 'void' && text === '') return
        if (promptDraft.kind === 'void') {
          if (typeof window !== 'undefined' && !window.confirm('确定要作废这条待办吗？')) return
          await mutate('POST', '/action', { id: promptDraft.id, action: 'void', reason: text || '用户作废' }, { message: '已作废。' })
          return
        }
        if (promptDraft.kind === 'reject') {
          await mutate('POST', '/action', { id: promptDraft.id, action: 'reject', reason: text }, { message: '已打回重做。' })
          return
        }
        await mutate('POST', '/action', { id: promptDraft.id, action: 'answer', text }, { message: '已回答。' })
      }

      const saveEdit = async () => {
        if (editing === null) return
        await mutate('POST', '/action', {
          id: editing.id,
          action: 'update',
          title: editing.title,
          detail: editing.detail,
          acceptance: editing.acceptance,
          priority: editing.priority,
          tags: editing.tags.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''),
        }, { message: '已保存。' })
        setEditing(null)
      }

      /**
       * Open the hand-off picker for one todo: expand it and ask the host which
       * conversations exist. Without a session list the picker still works — it
       * just offers the current conversation (and a new one when the host can
       * create it).
       */
      const openPicker = async (todo) => {
        setEditing(null)
        setPromptDraft(null)
        setFallback(null)
        setNotice(null)
        if (expanded !== todo.id) {
          setExpanded(todo.id)
          await loadRecord(todo.id)
        }
        const known = stateFromRef.current
        if (known?.canDeliver !== true) {
          // This deployment refuses hand-offs entirely (`deliverRequests: false`):
          // go straight to the copyable prompt instead of a picker that cannot send.
          try {
            const payload = await call('GET', `/prompt?${new URLSearchParams({ id: todo.id, ...envelope() }).toString()}`)
            setFallback({ id: todo.id, prompt: payload.prompt })
          } catch (failure) {
            setError(failure.message)
          }
          return
        }
        setPicker({
          id: todo.id,
          target: activeSession.id === null ? 'new' : 'current',
          cwd: known?.projectRoot ?? '',
          manualCwd: false,
          project: '__all__',
          sessions: [],
          canList: false,
          canCreate: false,
          loading: true,
          sending: false,
          error: null,
        })
        try {
          const payload = await call('GET', `/sessions?${new URLSearchParams({ ...envelope(), limit: '25' }).toString()}`)
          setPicker((current) => current === null || current.id !== todo.id ? current : {
            ...current,
            sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
            canList: payload.canList === true,
            canCreate: payload.canCreate === true,
            loading: false,
          })
        } catch (failure) {
          setPicker((current) => current === null || current.id !== todo.id ? current : { ...current, loading: false, error: failure.message })
        }
      }

      /**
       * Hand one todo to the chosen conversation. A global todo also decides where
       * the work happens, because it is not bound to one project: the picker's
       * project choice becomes a new session's working directory.
       */
      const sendToAgent = async (todo) => {
        if (picker === null) return
        const chosen = parseTarget(picker.target)
        const body = { id: todo.id, scope: todo.scope, target: chosen.target }
        if (chosen.target === 'session') body.targetSession = chosen.sessionId
        if (chosen.target === 'new') body.cwd = newSessionCwd(todo, picker, records[todo.id])
        setPicker((current) => (current === null ? current : { ...current, sending: true, error: null }))
        setBusy(true)
        try {
          const payload = await call('POST', '/request', { ...envelope(), ...body })
          setState((current) => (current === null ? current : mergeLevel(current, payload)))
          setNotice(payload.created === true
            ? `已新建会话（${payload.sessionId}）并把这条待办交给 AI；切到左侧会话列表即可看到它的进展。`
            : '已把这条待办交给 AI，请在对应会话里查看它的进展。')
          setError(null)
          setFallback(null)
          setPicker(null)
          await loadRecord(todo.id)
        } catch (failure) {
          setError(failure.message)
          setPicker((current) => (current === null ? current : { ...current, sending: false, error: failure.message }))
          setFallback(failure.prompt === undefined ? null : { id: todo.id, prompt: failure.prompt })
        } finally {
          setBusy(false)
        }
      }

      const copyPrompt = async () => {
        if (fallback === null) return
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
            await navigator.clipboard.writeText(fallback.prompt)
            setNotice('提示词已复制，粘贴到对话里发送即可。')
            return
          }
        } catch {
          // fall through to the message below
        }
        setNotice('无法自动复制，请手动选中下面的提示词。')
      }

      const level = state?.levels?.[scope] ?? null
      const rows = (level?.todos ?? []).filter((todo) => {
        if (!matchesFilter(todo, filter)) return false
        if (query.trim() === '') return true
        const needle = query.trim().toLowerCase()
        return todo.title.toLowerCase().includes(needle)
          || (todo.preview ?? '').toLowerCase().includes(needle)
          || todo.id.toLowerCase().includes(needle)
          || (todo.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
      })
      const projects = state?.projects ?? []
      const options = projectOptions(projects, state?.current?.path ?? null)
      const mode = manual !== null
        ? '手动选择'
        : activeSession.cwd !== null && activeSession.cwd !== ''
          ? '跟随当前会话'
          : state?.current?.source === 'default' ? '默认（最近使用的项目）' : '跟随当前会话'
      // The three group tabs are always present: they answer "is anything
      // waiting for me" even before the first state arrives, and a group never
      // disappears just because one of its statuses is empty.
      const enabledFilters = FILTERS

      const children = []

      children.push(h('div', { className: 'todoHead', key: 'head' },
        h('div', { className: 'todoTitleRow' },
          h('span', { className: 'todoTitle' }, '待办 Todo'),
          state === null
            ? null
            : h('span', { className: 'todoMeta' },
              `需要你处理 ${attentionOf(state, scope)} 条 · 项目共 ${totalOf(state, 'project')} 条 · 全局共 ${totalOf(state, 'global')} 条`)),
        h('div', { className: 'todoToolbar' },
          h('div', { className: 'todoTabs' },
            ['project', 'global'].map((candidate) => {
              const enabled = state?.levels?.[candidate]?.enabled === true
              return h('button', {
                key: candidate,
                type: 'button',
                className: 'todoTab',
                'data-active': String(scope === candidate),
                disabled: !enabled,
                title: enabled ? undefined : '该层级在当前配置下被禁用',
                onClick: () => { setScope(candidate); setExpanded(null); setEditing(null) },
              }, candidate === 'project' ? '项目' : '全局')
            })),
          options.length > 0 && scope === 'project'
            ? h('select', {
              className: 'todoSelect',
              value: manual ?? state?.current?.path ?? '',
              title: state?.projectRoot === undefined ? undefined : `项目目录：${state.projectRoot}`,
              onChange: (event) => {
                const chosen = event.target.value
                // Choosing the session's own project means "follow it" again.
                setManual(activeSession.cwd !== null && chosen === activeSession.cwd ? null : chosen)
                setExpanded(null)
                setEditing(null)
              },
            }, options.map((entry) => h('option', { key: entry.path, value: entry.path, title: entry.path }, entry.title)))
            : null,
          scope === 'project' && options.length === 0
            ? h('input', {
              className: 'todoInput todoGrow',
              placeholder: '项目目录（绝对路径）',
              value: manual ?? '',
              onChange: (event) => { setManual(event.target.value); setExpanded(null) },
            })
            : null,
          scope === 'project' && manual !== null
            ? h('button', {
              className: 'todoButton',
              type: 'button',
              title: '回到跟随当前会话的项目',
              onClick: () => { setManual(null); setExpanded(null) },
            }, '跟随会话')
            : null,
          h('input', {
            className: 'todoInput',
            placeholder: '搜索…',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', {
            className: 'todoButton',
            type: 'button',
            'data-primary': 'true',
            onClick: () => { setAdding((current) => !current); setNotice(null) },
          }, adding ? '收起' : '＋ 手动添加'),
          h('button', {
            className: 'todoButton',
            type: 'button',
            disabled: busy,
            onClick: () => {
              void load()
              // An expanded row shows the full record, which `load` does not refresh.
              if (expanded !== null) void loadRecord(expanded)
            },
          }, busy ? '…' : '刷新')),
        h('div', { className: 'todoToolbar' },
          h('div', { className: 'todoTabs' },
            enabledFilters.map((candidate) => {
              const group = GROUP_BY_ID.get(candidate) ?? { label: candidate, hint: '' }
              const count = countOf(state, scope, candidate)
              return h('button', {
                key: candidate,
                type: 'button',
                className: 'todoTab',
                'data-active': String(filter === candidate),
                title: group.hint,
                onClick: () => setFilter(candidate),
              }, group.label,
              h('span', { className: 'todoCount' }, String(count)))
            }))),
        state === null
          ? null
          : h('div', { className: 'todoMeta' },
            scope === 'project'
              ? `${mode}：${state.projectRoot}`
              : '全局：所有项目共用')))

      if (adding) {
        children.push(h('div', { className: 'todoComposer', key: 'composer' },
          labelledField('todo-add-title', '标题', h('input', {
            id: 'todo-add-title',
            className: 'todoInput',
            placeholder: '一句话说清要做什么（必填）',
            value: draft.title,
            autoFocus: true,
            onChange: (event) => setDraft({ ...draft, title: event.target.value }),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void addTodo()
            },
          })),
          labelledField('todo-add-detail', '详细说明', h('textarea', {
            id: 'todo-add-detail',
            className: 'todoTextarea',
            placeholder: '补充背景、范围和约束（可选）',
            value: draft.detail,
            onChange: (event) => setDraft({ ...draft, detail: event.target.value }),
          })),
          h('div', { className: 'todoToolbar' },
            labelledField('todo-add-acceptance', '验收标准', h('input', {
              id: 'todo-add-acceptance',
              className: 'todoInput',
              placeholder: '怎样算完成（建议填写）',
              value: draft.acceptance,
              onChange: (event) => setDraft({ ...draft, acceptance: event.target.value }),
            }), 'todoGrow'),
            labelledField('todo-add-priority', '优先级', h('select', {
              id: 'todo-add-priority',
              className: 'todoSelect',
              value: draft.priority,
              onChange: (event) => setDraft({ ...draft, priority: event.target.value }),
            }, Object.keys(PRIORITY_META).map((priority) => h('option', { key: priority, value: priority }, PRIORITY_META[priority].label)))),
            labelledField('todo-add-tags', '标签', h('input', {
              id: 'todo-add-tags',
              className: 'todoInput',
              placeholder: '用逗号分隔',
              value: draft.tags,
              onChange: (event) => setDraft({ ...draft, tags: event.target.value }),
            }), 'todoGrow'),
            h('button', {
              className: 'todoButton',
              type: 'button',
              'data-primary': 'true',
              disabled: busy || draft.title.trim() === '' || level?.enabled !== true,
              onClick: () => void addTodo(),
            }, `添加到${scope === 'project' ? '项目' : '全局'}`))))
      }

      if (error !== null) children.push(h('div', { className: 'todoError', key: 'error' }, error))
      if (notice !== null) children.push(h('div', { className: 'todoNotice', key: 'notice' }, notice))

      if (fallback !== null) {
        children.push(h('div', { className: 'todoPromptDraft', key: 'fallback' },
          h('div', { className: 'todoMeta' }, '这条待办没有直接发给 AI。可以复制下面的提示词，粘贴到对话里发送：'),
          h('textarea', { className: 'todoTextarea', readOnly: true, value: fallback.prompt, onFocus: (event) => event.target.select() }),
          h('div', { className: 'todoToolbar' },
            h('button', { className: 'todoButton', type: 'button', onClick: () => void copyPrompt() }, '复制提示词'),
            h('button', { className: 'todoButton', type: 'button', onClick: () => setFallback(null) }, '关闭'))))
      }

      if (level !== null && level.enabled !== true) {
        children.push(h('div', { className: 'todoState', key: 'disabled' }, '该层级在当前插件配置下被禁用（config.level）。'))
      } else if (rows.length === 0) {
        children.push(h('div', { className: 'todoState', key: 'empty' },
          query.trim() !== '' ? '没有匹配的待办。' : filter === 'attention' ? '没有需要你处理的待办。' : filter === 'progress' ? '没有进行中的待办。' : '这里还没有待办。'))
      }

      children.push(h('div', { className: 'todoList', key: 'list' },
        rows.map((todo) => {
          const isExpanded = expanded === todo.id
          const record = records[todo.id] ?? null
          const meta = STATUS_META[todo.status] ?? { label: todo.status, hint: '' }
          const isEditing = editing !== null && editing.id === todo.id
          const draftOpen = promptDraft !== null && promptDraft.id === todo.id
          const actions = (todo.actions ?? []).slice()
          const rowsHtml = []

          rowsHtml.push(h('div', {
            className: 'todoItemHead',
            key: 'head',
            onClick: () => void toggleRow(todo),
          },
          h('span', {
            className: 'todoBadge',
            style: { color: todo.status === 'done' ? 'var(--dsw-alias-state-success-primary,#1a7f37)' : todo.status === 'void' ? 'var(--dsw-alias-label-caption,#8b949e)' : 'var(--dsw-alias-label-secondary,#57606a)' },
          }, meta.label),
          h('span', { className: 'todoItemTitle', 'data-done': String(todo.status === 'done') }, todo.title),
          todo.priority !== 'normal'
            ? h('span', { className: 'todoPriority' }, `${PRIORITY_META[todo.priority]?.marker ?? ''} ${PRIORITY_META[todo.priority]?.label ?? todo.priority}`)
            : null,
          ...(todo.tags ?? []).map((tag) => h('span', { className: 'todoTag', key: tag }, tag)),
          todo.origin === 'ai' ? h('span', { className: 'todoMeta' }, 'AI 提出') : null,
          h('span', { className: 'todoMeta' }, new Date(todo.updatedAt || todo.at).toLocaleString()),
          h('span', { className: 'todoActions' },
            actions.filter((action) => action !== 'update').map((action) => h('button', {
              key: action,
              type: 'button',
              className: 'todoButton',
              'data-danger': String(DANGER_ACTIONS.includes(action)),
              'data-primary': String(PRIMARY_ACTIONS.includes(action) && !DANGER_ACTIONS.includes(action)),
              disabled: busy,
              title: meta.hint,
              onClick: (event) => { event.stopPropagation(); runAction(todo, action) },
            }, actionLabel(todo, action))),
            isExpanded ? null : h('span', { className: 'todoMeta' }, '详情 ▾'))))

          if (todo.status === 'blocked' && todo.question !== undefined && todo.question !== null && !isExpanded) {
            rowsHtml.push(h('div', { className: 'todoError', key: 'q' }, `AI 需要你补充：${todo.question}`))
          }
          if (todo.status === 'review' && todo.submission !== null) {
            rowsHtml.push(h('div', { className: 'todoMeta', key: 'sub' }, `AI 提交：${todo.submission.summary}`))
          }

          if (isExpanded) {
            const fields = []
            if (record === null) {
              fields.push(h('div', { className: 'todoState', key: 'loading' }, '读取详情…'))
            } else {
              fields.push(h('div', { className: 'todoField', key: 'detail' },
                h('span', { className: 'todoFieldLabel' }, '详细说明'),
                h('div', { className: 'todoFieldValue' }, record.detail.length > 0 ? record.detail : '（空）')))
              fields.push(h('div', { className: 'todoField', key: 'acceptance' },
                h('span', { className: 'todoFieldLabel' }, '验收标准'),
                h('div', { className: 'todoFieldValue' }, record.acceptance.length > 0 ? record.acceptance : '（未填写）')))
              if (record.question !== null && record.question !== undefined) {
                fields.push(h('div', { className: 'todoField', key: 'question' },
                  h('span', { className: 'todoFieldLabel' }, '等待你的回答'),
                  h('div', { className: 'todoFieldValue' }, record.question)))
              }
              if (record.answers.length > 0) {
                fields.push(h('div', { className: 'todoField', key: 'answers' },
                  h('span', { className: 'todoFieldLabel' }, `已回答 ${record.answers.length} 次`),
                  ...record.answers.map((answer, index) => h('div', { className: 'todoFieldValue', key: index }, `· ${answer.text}`))))
              }
              if (record.submission !== null && record.submission !== undefined) {
                fields.push(h('div', { className: 'todoField', key: 'submission' },
                  h('span', { className: 'todoFieldLabel' }, 'AI 提交的结果'),
                  h('div', { className: 'todoFieldValue' }, record.submission.summary),
                  record.submission.evidence ? h('div', { className: 'todoMeta' }, `证据：${record.submission.evidence}`) : null))
              }
              if (record.approval !== null && record.approval !== undefined) {
                fields.push(h('div', { className: 'todoMeta', key: 'approval' }, `你在 ${new Date(record.approval.at).toLocaleString()} 确认了结果${record.approval.note ? `：${record.approval.note}` : ''}`))
              }
              if (record.completion !== null && record.completion !== undefined) {
                fields.push(h('div', { className: 'todoMeta', key: 'completion' }, `${new Date(record.completion.at).toLocaleString()} 由${record.completion.by === 'ai' ? ' AI ' : '你'}标记为已完成`))
              }
              if (record.voided !== null && record.voided !== undefined) {
                fields.push(h('div', { className: 'todoMeta', key: 'voided' }, `已作废（${record.voided.by === 'ai' ? 'AI' : '你'}）：${record.voided.reason}`))
              }
              fields.push(h('div', { className: 'todoField', key: 'meta' },
                h('span', { className: 'todoFieldLabel' }, '记录'),
                h('div', { className: 'todoMeta' }, `${record.id} · 创建 ${new Date(record.at).toLocaleString()}${record.editedAt ? ' · 已编辑' : ''} · 层级 ${record.scope}`)))
              fields.push(h('div', { className: 'todoField', key: 'history' },
                h('span', { className: 'todoFieldLabel' }, `历史（最近 ${record.history.length} 条）`),
                h('div', { className: 'todoTimeline' },
                  ...record.history.slice(-8).map((entry, index) => h('div', { key: index },
                    `${new Date(entry.at).toLocaleString()} · ${entry.by === 'ai' ? 'AI' : entry.by === 'user' ? '你' : '系统'} · ${entry.action}：${entry.from ?? '—'} → ${entry.to}${entry.note ? `（${entry.note}）` : ''}`)))))
            }

            const pickerOpen = picker !== null && picker.id === todo.id
            let pickerBlock = null
            if (pickerOpen) {
              const allSessions = Array.isArray(picker.sessions) ? picker.sessions : []
              const wanted = projectFilterOf(picker)
              const visible = wanted === null ? allSessions : allSessions.filter((session) => session.projectRoot === wanted)
              const currentSession = allSessions.find((session) => session.id === activeSession.id)
              const choices = targetOptions({
                currentId: activeSession.id,
                currentTitle: currentSession === undefined ? undefined : currentSession.title,
                sessions: visible,
                canCreate: picker.canCreate === true,
              })
              // Never render a value that is not an option: <select> would silently
              // show a different conversation than the one that will receive the todo.
              const target = choices.some((choice) => choice.value === picker.target) ? picker.target : choices[0].value
              const projectRoots = projectChoices({ projects: state?.projects, currentRoot: state?.projectRoot, sessions: allSessions })
              const cwdValue = picker.manualCwd === true
                ? '__manual__'
                : projectRoots.some((choice) => choice.path === picker.cwd) ? picker.cwd : '__manual__'
              const resolvedCwd = newSessionCwd(todo, picker, record)
              pickerBlock = h('div', { className: 'todoPromptDraft', key: 'picker' },
                h('div', { className: 'todoFieldLabel' }, '投递到哪个会话'),
                h('select', {
                  className: 'todoSelect',
                  value: target,
                  onChange: (event) => setPicker({ ...picker, target: event.target.value }),
                }, choices.map((choice) => h('option', {
                  key: choice.value,
                  value: choice.value,
                  title: choice.title,
                  disabled: choice.disabled === true,
                }, choice.label))),
                todo.scope === 'global'
                  ? h('div', { className: 'todoToolbar' },
                    h('span', { className: 'todoFieldLabel' }, '筛选项目'),
                    h('select', {
                      className: 'todoSelect',
                      value: picker.project ?? '__all__',
                      onChange: (event) => setPicker({ ...picker, project: event.target.value }),
                    }, [h('option', { key: '__all__', value: '__all__' }, '全部项目')]
                      .concat(projectRoots.map((choice) => h('option', { key: choice.path, value: choice.path }, choice.title)))))
                  : null,
                target === 'new'
                  ? h('div', { className: 'todoField' },
                    h('span', { className: 'todoFieldLabel' }, todo.scope === 'global' ? '新会话的项目（工作目录）' : '新会话的项目'),
                    todo.scope === 'global'
                      ? h('div', { className: 'todoToolbar' },
                        h('select', {
                          className: 'todoSelect todoGrow',
                          value: cwdValue,
                          onChange: (event) => {
                            const chosen = event.target.value
                            setPicker(chosen === '__manual__'
                              ? { ...picker, manualCwd: true }
                              : { ...picker, manualCwd: false, cwd: chosen })
                          },
                        }, projectRoots.map((choice) => h('option', { key: choice.path, value: choice.path }, choice.title))
                          .concat([h('option', { key: '__manual__', value: '__manual__' }, '手动输入路径…')])),
                        picker.manualCwd === true
                          ? h('input', {
                            className: 'todoInput todoGrow',
                            placeholder: '例如 D:\\work\\my-project',
                            value: picker.cwd,
                            onChange: (event) => setPicker({ ...picker, cwd: event.target.value }),
                          })
                          : null)
                      : h('span', { className: 'todoMeta' }, record?.projectRoot ?? state?.projectRoot ?? '（未知）'))
                  : null,
                h('div', { className: 'todoToolbar' },
                  h('button', {
                    className: 'todoButton',
                    type: 'button',
                    'data-primary': 'true',
                    disabled: busy || picker.sending === true || (target === 'new' && resolvedCwd.trim() === ''),
                    onClick: () => void sendToAgent(todo),
                  }, picker.sending === true ? '发送中…' : '发送到会话'),
                  h('button', {
                    className: 'todoButton',
                    type: 'button',
                    onClick: () => setPicker(null),
                  }, '取消')),
                picker.loading === true ? h('div', { className: 'todoState' }, '正在读取会话列表…') : null,
                picker.canList !== true && picker.loading !== true
                  ? h('div', { className: 'todoMeta' }, '当前宿主无法列出会话，可以投给当前会话，或新建一个会话。')
                  : null,
                picker.canCreate !== true && picker.loading !== true
                  ? h('div', { className: 'todoMeta' }, '当前宿主不支持新建会话。')
                  : null,
                picker.error !== null && picker.error !== undefined ? h('div', { className: 'todoError' }, picker.error) : null)
            }

            if (isEditing) {
              // The edit form opens with the todo's current values filled in, so a
              // placeholder cannot say what a box is once it has content. Every
              // control therefore carries a visible, associated label (same as the
              // read-only detail above), and the priority select drops its inline
              // "优先级：" prefix because the label now names it.
              const fieldId = (field) => `todo-edit-${editing.id}-${field}`
              rowsHtml.push(h('div', { className: 'todoDetail', key: 'edit' },
                labelledField(fieldId('title'), '标题', h('input', {
                  id: fieldId('title'),
                  className: 'todoInput',
                  value: editing.title,
                  autoFocus: true,
                  onChange: (event) => setEditing({ ...editing, title: event.target.value }),
                })),
                labelledField(fieldId('detail'), '详细说明', h('textarea', {
                  id: fieldId('detail'),
                  className: 'todoTextarea',
                  placeholder: '补充背景、范围和约束',
                  value: editing.detail,
                  onChange: (event) => setEditing({ ...editing, detail: event.target.value }),
                })),
                labelledField(fieldId('acceptance'), '验收标准', h('textarea', {
                  id: fieldId('acceptance'),
                  className: 'todoTextarea',
                  placeholder: '怎样算完成（建议填写）',
                  value: editing.acceptance,
                  onChange: (event) => setEditing({ ...editing, acceptance: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void saveEdit()
                    if (event.key === 'Escape') setEditing(null)
                  },
                })),
                h('div', { className: 'todoToolbar' },
                  labelledField(fieldId('priority'), '优先级', h('select', {
                    id: fieldId('priority'),
                    className: 'todoSelect',
                    value: editing.priority,
                    onChange: (event) => setEditing({ ...editing, priority: event.target.value }),
                  }, Object.keys(PRIORITY_META).map((priority) => h('option', { key: priority, value: priority }, PRIORITY_META[priority].label)))),
                  labelledField(fieldId('tags'), '标签', h('input', {
                    id: fieldId('tags'),
                    className: 'todoInput',
                    placeholder: '用逗号分隔',
                    value: editing.tags,
                    onChange: (event) => setEditing({ ...editing, tags: event.target.value }),
                  }), 'todoGrow')),
                h('div', { className: 'todoToolbar' },
                  h('button', { className: 'todoButton', type: 'button', 'data-primary': 'true', disabled: busy, onClick: () => void saveEdit() }, '保存'),
                  h('button', { className: 'todoButton', type: 'button', onClick: () => setEditing(null) }, '取消'))))
            } else {
              rowsHtml.push(h('div', { className: 'todoDetail', key: 'detail' },
                ...fields,
                pickerOpen
                  ? pickerBlock
                  : draftOpen
                    ? h('div', { className: 'todoPromptDraft', key: 'draft' },
                    h('div', { className: 'todoMeta' },
                      promptDraft.kind === 'answer' ? '回答 AI 的问题：' : promptDraft.kind === 'void' ? '作废原因（可留空）：' : '打回原因：'),
                    h('textarea', {
                      className: 'todoTextarea',
                      autoFocus: true,
                      value: promptDraft.text,
                      placeholder: promptDraft.kind === 'void' ? '例如：需求变了，不做了' : '把 AI 需要的信息写清楚',
                      onChange: (event) => setPromptDraft({ ...promptDraft, text: event.target.value }),
                    }),
                    h('div', { className: 'todoToolbar' },
                      h('button', {
                        className: 'todoButton',
                        type: 'button',
                        'data-primary': 'true',
                        disabled: busy || (promptDraft.kind !== 'void' && promptDraft.text.trim() === ''),
                        onClick: () => void submitPromptDraft(),
                      }, '提交'),
                      h('button', { className: 'todoButton', type: 'button', onClick: () => setPromptDraft(null) }, '取消')))
                  : h('div', { className: 'todoToolbar', key: 'rowActions' },
                    h('button', {
                      className: 'todoButton',
                      type: 'button',
                      disabled: busy,
                      onClick: () => runAction(record, 'update'),
                    }, actionLabel(record, 'update')),
                    todo.status === 'blocked'
                      ? h('button', {
                        className: 'todoButton',
                        type: 'button',
                        'data-primary': 'true',
                        disabled: busy,
                        onClick: () => runAction(record, 'answer'),
                      }, '回答 AI')
                      : null,
                    state?.canDeliver === true && (todo.status === 'open' || todo.status === 'working' || todo.status === 'blocked')
                      ? h('button', {
                        className: 'todoButton',
                        type: 'button',
                        disabled: busy,
                        onClick: () => void openPicker(record),
                      }, '交给 AI 完成')
                      : null)))
            }
          }

          return h('div', {
            className: 'todoItem',
            key: `${todo.scope}:${todo.id}`,
            'data-expanded': String(isExpanded),
            'data-attention': String(isAttention(todo)),
          }, ...rowsHtml)
        })))

      if (level?.file !== undefined) {
        children.push(h('div', { className: 'todoPath', key: 'path' }, `文件：${level.file}`))
      }

      return h('div', { className: 'todoPage' }, ...children)
    }

    /** Client services this plugin waits for. */
    const inject = ['slots']

    /**
     * Register the session bridge, the sidebar icon, and the center page.
     * @param {object} ctx - client plugin context.
     */
    function apply(ctx) {
      // The `main` slot is keyed by the active sidebar panel id, so both
      // registrations must use the same PANEL_ID.
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, TodoPage))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 41,
        label: '待办',
      }, TodoIcon))
      // Session-scoped: renders nothing, reports the current session to the
      // root-scoped page above so it opens that session's project and hands
      // todos to the right conversation.
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'todo-session',
        order: 901,
      }, TodoSessionBridge))
    }

    exports.apply = apply
    exports.inject = inject
    exports.TodoPage = TodoPage
    exports.TodoIcon = TodoIcon
    exports.TodoSessionBridge = TodoSessionBridge
    // Exported for tests.
    exports.projectOptions = projectOptions
    exports.targetOptions = targetOptions
    exports.parseTarget = parseTarget
    exports.sessionLabel = sessionLabel
    exports.projectChoices = projectChoices
    exports.newSessionCwd = newSessionCwd
    exports.folderName = folderName
    exports.matchesFilter = matchesFilter
    exports.actionLabel = actionLabel
    exports.totalOf = totalOf
    exports.countOf = countOf
    exports.attentionOf = attentionOf
    exports.isAttention = isAttention
    exports.mergeLevel = mergeLevel
    exports.FILTERS = FILTERS
    exports.FILTER_GROUPS = FILTER_GROUPS
    exports.STATUS_META = STATUS_META
    // The bridge's report, exported so the follow behavior is testable.
    exports.activeSession = activeSession
    return module.exports
  },
})
