/**
 * Client-half tests for `dsh-plugin-todo` (`lib/client.js`).
 *
 * The bundle is a browser classic script, so this test builds the minimum page
 * environment it touches: a `window.__ModuleLoader__` sink, a `document` that
 * records the stylesheet insert, and a stub `react` (the host-side `react`
 * junction in this environment is dangling, and the browser seed table is what
 * really supplies React).
 *
 * Most assertions call the exported parts directly. The one data-driven render
 * uses a small hook host that persists state across re-renders and commits
 * effects once their dependencies stop changing, which is enough to let the
 * page's one-shot `load()` effect run its `fetch` and render the result.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { API_PREFIX, CLIENT_HEADER } from '../lib/api.js'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/**
 * The hook object the stub React dispatches to. A real mount swaps itself in
 * for the duration of one render; otherwise the loose, stateless hooks below
 * answer, so a direct `TodoPage()` call renders once and records its effects.
 * @type {{ useState: Function, useRef: Function, useEffect: Function, useCallback: Function }}
 */
let activeHooks = null

const React = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
    }
  },
  useState(initial) { return activeHooks.useState(initial) },
  useRef(initial) { return activeHooks.useRef(initial) },
  useEffect(callback, deps) { return activeHooks.useEffect(callback, deps) },
  useCallback(callback, deps) { return activeHooks.useCallback(callback, deps) },
  /** Effects recorded by the loose hooks, for tests that want to run them. */
  effects: [],
}

const looseHooks = {
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useRef(initial) { return { current: initial } },
  useCallback(callback) { return callback },
  // Effects are recorded, never run implicitly: rendering a component directly
  // cannot start a fetch or a timer; a test that wants them runs them.
  useEffect(callback) { React.effects.push(callback) },
}
activeHooks = looseHooks

/** Collect every string rendered anywhere in a stub element tree. */
function texts(node, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (typeof node === 'string' || typeof node === 'number') {
    found.push(String(node))
    return found
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, found)
    return found
  }
  for (const child of node.children ?? []) texts(child, found)
  return found
}

/** Every element in a stub tree matching one type. */
function elements(node, type, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) elements(child, type, found)
    return found
  }
  if (node.type === type) found.push(node)
  for (const child of node.children ?? []) elements(child, type, found)
  return found
}

/** Whether two hook dependency lists are shallow-equal. */
function sameDeps(left, right) {
  if (left === right) return true
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

/**
 * Mount one function component with persistent hook state.
 *
 * One cell per hook position survives every render; a setter writes its cell and
 * marks the mount dirty; effects are committed after each render and skipped
 * once their dependencies stop changing — which is what keeps the page's
 * `load()` effect one-shot instead of firing on every re-render.
 * @param {(props: object) => unknown} component - the function component.
 */
function createMount(component) {
  const cells = []
  const effectSlots = new Set()
  let pending = []
  let index = 0
  let dirty = false

  const hooks = {
    useState(initial) {
      const at = index++
      if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial
      return [cells[at], (value) => {
        const next = typeof value === 'function' ? value(cells[at]) : value
        if (!Object.is(next, cells[at])) {
          cells[at] = next
          dirty = true
        }
      }]
    },
    useRef(initial) {
      const at = index++
      if (!(at in cells)) cells[at] = { current: initial }
      return cells[at]
    },
    useCallback(callback, deps) {
      const at = index++
      const previous = cells[at]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.callback
      cells[at] = { callback, deps }
      return callback
    },
    useEffect(callback, deps) {
      const at = index++
      effectSlots.add(at)
      const previous = cells[at]
      if (previous !== undefined && deps !== undefined && sameDeps(previous.deps, deps)) return
      pending.push({ at, callback, deps })
    },
  }

  const render = () => {
    const previousHooks = activeHooks
    activeHooks = hooks
    index = 0
    pending = []
    try {
      const tree = component({})
      dirty = false
      const queue = pending
      pending = []
      for (const entry of queue) {
        const previous = cells[entry.at]
        if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
        const cleanup = entry.callback()
        cells[entry.at] = { deps: entry.deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
      }
      return tree
    } finally {
      activeHooks = previousHooks
    }
  }

  return {
    tree: render(),
    /**
     * Give the pending promises a turn and re-render whenever a setter fired.
     * @returns {Promise<unknown>} the latest tree.
     */
    async settle(passes = 5) {
      for (let pass = 0; pass < passes; pass += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (dirty) this.tree = render()
      }
      return this.tree
    },
    /** Run every effect cleanup, as unmounting the panel would. */
    unmount() {
      for (const at of effectSlots) {
        const cell = cells[at]
        if (cell !== undefined && typeof cell.cleanup === 'function') {
          cell.cleanup()
          cell.cleanup = null
        }
      }
    },
  }
}

/** @type {{ registration: any, appended: any[] }} */
let page

before(async () => {
  const appended = []
  let registration
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = { __ModuleLoader__: { load(value) { registration = value } } }
  globalThis.document = {
    querySelector: () => null,
    createElement() { return { dataset: {}, textContent: '' } },
    head: { appendChild(node) { appended.push(node) } },
  }
  try {
    await import(new URL('../lib/client.js', import.meta.url).href)
    // Materialize once while the page stubs are installed: the factory inserts
    // its stylesheet synchronously, and the module system claims it right after.
    registration.factory((specifier) => {
      if (specifier === 'react') return React
      throw new Error(`unexpected require(${specifier})`)
    })
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
  page = { registration, appended }
})

/** Instantiate the bundle's plugin module against the stub React. */
function loadClientModule() {
  return page.registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require(${specifier})`)
  })
}

describe('todo client bundle', () => {
  it('registers a factory under the package name and claims its stylesheet', () => {
    assert.equal(typeof page.registration, 'object')
    assert.equal(page.registration.id, 'dsh-plugin-todo')
    assert.equal(typeof page.registration.factory, 'function')
    // The module system claims untagged <style> tags present when the factory
    // returns, so the stylesheet must be inserted while it runs.
    assert.equal(page.appended.length, 1)
    const style = page.appended[0]
    assert.equal(style.dataset.plugin, 'dsh-plugin-todo')
    assert.equal(style.dataset.pluginCss, 'dsh-plugin-todo/client.css')
    assert.match(style.textContent, /\.todoPage/)
  })

  it('exposes the Cordis plugin shape and the panel parts', () => {
    const clientModule = loadClientModule()
    assert.equal(typeof clientModule.apply, 'function')
    assert.deepEqual(clientModule.inject, ['slots'])
    assert.equal(typeof clientModule.TodoPage, 'function')
    assert.equal(typeof clientModule.TodoIcon, 'function')
    assert.equal(typeof clientModule.TodoSessionBridge, 'function')
  })

  it('pairs the sidebar icon and the main panel under one id', () => {
    const clientModule = loadClientModule()
    const registered = []
    const injected = []
    const ctx = {
      slots: {
        inject(key, callback) { injected.push(key); registered.push(callback()) },
        register(options, component) { return { options, component } },
      },
    }
    clientModule.apply(ctx)
    assert.deepEqual(injected, ['main', 'sidebar.panellist', 'conversation.session.header.utilities'])
    assert.equal(registered.length, 3)
    const main = registered[0]
    const icon = registered[1]
    const bridge = registered[2]

    assert.equal(main.options.name, 'main')
    assert.equal(icon.options.name, 'sidebar.panellist')
    // The center panel is dispatched by the panellist id, so the keys must match.
    assert.equal(main.options.key, icon.options.id)
    assert.equal(main.options.key, 'todo')
    assert.equal(icon.options.id, 'todo')
    assert.equal(icon.options.order, 41)
    assert.equal(icon.options.label, '待办')
    assert.equal(main.component, clientModule.TodoPage)
    assert.equal(icon.component, clientModule.TodoIcon)

    // The session bridge is a session-scoped, additive list entry.
    assert.equal(bridge.options.name, 'conversation.session.header.utilities')
    assert.equal(bridge.options.id, 'todo-session')
    assert.equal(bridge.component, clientModule.TodoSessionBridge)
  })

  it('reports the session cwd through the invisible bridge', () => {
    const clientModule = loadClientModule()
    const selectors = []
    React.effects.length = 0
    const bridge = clientModule.TodoSessionBridge({
      sessionId: 'session-1234',
      useSessions: (selector) => {
        selectors.push(selector)
        return selector({ byId: { 'session-1234': { cwd: 'D:\\work\\proj' } } })
      },
    })
    assert.equal(bridge.type, 'span')
    assert.equal(bridge.props['aria-hidden'], 'true')
    assert.match(bridge.props.style.display, /none/)
    // The selector maps the session id to that session's own working directory.
    assert.equal(selectors[0]({ byId: { 'session-1234': { cwd: 'D:\\work\\proj' } } }), 'D:\\work\\proj')
    assert.equal(selectors[0]({ byId: {} }), null)
    assert.equal(selectors[0]({ byId: { other: { cwd: 'x' } } }), null)

    // The effect publishes the session for the root-scoped center page.
    for (const effect of React.effects.splice(0)) effect()
    assert.deepEqual(clientModule.activeSession, { id: 'session-1234', cwd: 'D:\\work\\proj' })
    clientModule.activeSession.id = null
    clientModule.activeSession.cwd = null

    // A host without `useSessions` still renders, and reports an unknown session
    // through the fallback selector.
    React.effects.length = 0
    const unknown = clientModule.TodoSessionBridge({ sessionId: 'session-9999' })
    assert.equal(unknown.type, 'span')
    for (const effect of React.effects.splice(0)) effect()
    assert.deepEqual(clientModule.activeSession, { id: 'session-9999', cwd: null })
    clientModule.activeSession.id = null
    clientModule.activeSession.cwd = null
  })

  it('renders the sidebar icon at the requested size', () => {
    const clientModule = loadClientModule()
    const icon = clientModule.TodoIcon({ size: 18, active: true })
    assert.equal(icon.type, 'svg')
    assert.equal(icon.props.width, 18)
    assert.equal(icon.props.height, 18)
    assert.equal(icon.children.length, 4)
  })

  it('never lets the project dropdown name a different project than the one in use', () => {
    const clientModule = loadClientModule()
    const workspaces = [{ path: 'D:\\work\\a', title: 'a' }, { path: 'D:\\work\\b', title: 'b' }]

    // The project in use is registered: no duplicate entry.
    const registered = clientModule.projectOptions(workspaces, 'D:\\work\\b')
    assert.deepEqual(registered.map((entry) => entry.path), ['D:\\work\\a', 'D:\\work\\b'])
    assert.deepEqual(registered.map((entry) => entry.title), ['a', 'b'])
    assert.ok(registered.every((entry) => entry.followed === false))

    // The project in use is NOT registered (a session whose directory is not a
    // workspace): it must still be an option, first and clearly labelled —
    // otherwise <select> falls back to displaying the first option and names a
    // project the panel is not editing.
    const unregistered = clientModule.projectOptions(workspaces, 'D:\\files\\projects\\trusted_data')
    assert.deepEqual(unregistered.map((entry) => entry.path), ['D:\\files\\projects\\trusted_data', 'D:\\work\\a', 'D:\\work\\b'])
    assert.equal(unregistered[0].title, 'trusted_data（当前会话）')
    assert.equal(unregistered[0].followed, true)

    // A trailing separator does not confuse the label.
    assert.equal(clientModule.projectOptions([], 'D:\\files\\trailing\\')[0].title, 'trailing（当前会话）')

    // Nothing to choose from: the page renders its path input instead.
    assert.deepEqual(clientModule.projectOptions([], null), [])
    assert.deepEqual(clientModule.projectOptions([], ''), [])
  })

  it('filters rows, labels actions, and merges level payloads', () => {
    const clientModule = loadClientModule()
    assert.equal(clientModule.matchesFilter({ status: 'open' }, 'all'), true)
    assert.equal(clientModule.matchesFilter({ status: 'open' }, 'open'), true)
    assert.equal(clientModule.matchesFilter({ status: 'open' }, 'done'), false)
    for (const status of ['proposed', 'review', 'blocked']) assert.equal(clientModule.matchesFilter({ status }, 'attention'), true)
    for (const status of ['open', 'working', 'done', 'void']) assert.equal(clientModule.matchesFilter({ status }, 'attention'), false)
    // The three group tabs are the whole toolbar: no tab per status any more.
    assert.deepEqual(clientModule.FILTERS, ['attention', 'progress', 'all'])
    for (const status of ['open', 'working']) assert.equal(clientModule.matchesFilter({ status }, 'progress'), true)
    for (const status of ['proposed', 'review', 'blocked', 'done', 'void']) assert.equal(clientModule.matchesFilter({ status }, 'progress'), false)
    // A single status stays filterable even without its own tab.
    assert.equal(clientModule.matchesFilter({ status: 'void' }, 'void'), true)
    // The row highlight trusts the server's flag; it does not re-derive it
    // from the status, so the status list is not duplicated on the client.
    assert.equal(clientModule.isAttention({ attention: true }), true)
    assert.equal(clientModule.isAttention({ attention: false }), false)
    assert.equal(clientModule.isAttention({ status: 'review' }), false)

    assert.equal(clientModule.actionLabel({ status: 'review' }, 'reject'), '打回重做')
    assert.equal(clientModule.actionLabel({ status: 'proposed' }, 'reject'), '驳回')
    assert.equal(clientModule.actionLabel({ status: 'open' }, 'request'), '交给 AI 完成')
    assert.equal(clientModule.actionLabel({ status: 'proposed' }, 'accept'), '确认接受')
    assert.equal(clientModule.actionLabel({ status: 'review' }, 'confirm'), '确认完成')
    assert.equal(clientModule.actionLabel({ status: 'done' }, 'reopen'), '重新打开')
    // The edit action names the todo: its form changes title, detail,
    // acceptance, priority, and tags, not one "detail" field.
    assert.equal(clientModule.actionLabel({ status: 'open' }, 'update'), '编辑待办')
    // An unknown action falls back to its own name.
    assert.equal(clientModule.actionLabel({ status: 'open' }, 'mystery'), 'mystery')

    const state = {
      levels: {
        project: { enabled: true, total: 7, counts: { proposed: 2, review: 1, blocked: 1, open: 3 } },
        global: { enabled: false, total: 99, counts: {} },
      },
    }
    assert.equal(clientModule.totalOf(state, 'project'), 7)
    // A disabled level contributes nothing, whatever it reports.
    assert.equal(clientModule.totalOf(state, 'global'), 0)
    assert.equal(clientModule.totalOf(null, 'project'), 0)
    assert.equal(clientModule.attentionOf(state, 'project'), 4)
    assert.equal(clientModule.attentionOf(state, 'global'), 0)
    // A group tab sums the counts of the statuses it bundles.
    assert.equal(clientModule.countOf(state, 'project', 'progress'), 3)
    assert.equal(clientModule.countOf(state, 'project', 'all'), 7)
    assert.equal(clientModule.countOf(state, 'global', 'all'), 0, 'a disabled level counts as zero')

    const merged = clientModule.mergeLevel(state, { scope: 'project', enabled: true, total: 8, counts: {}, todos: [] })
    assert.equal(merged.levels.project.total, 8)
    assert.equal(merged.levels.global.total, 99)
    // The merge does not mutate the state it was given.
    assert.equal(state.levels.project.total, 7)
    const withGlobal = clientModule.mergeLevel(state, { scope: 'global', enabled: true, total: 1, counts: {}, todos: [] })
    assert.equal(withGlobal.levels.global.total, 1)
  })

  it('covers exactly the seven statuses and keeps progress to open/working', () => {
    const clientModule = loadClientModule()
    // The state machine has seven statuses: `confirmed` was removed because a
    // user confirmation now completes the todo directly, so the panel must not
    // reintroduce a badge or a tab for it.
    assert.deepEqual(
      Object.keys(clientModule.STATUS_META).sort(),
      ['blocked', 'done', 'open', 'proposed', 'review', 'void', 'working'],
    )
    // `review` is the human decision point: the row hint says the confirmation
    // itself completes the todo.
    assert.match(clientModule.STATUS_META.review.hint, /确认即完成/)
    // The progress tab is the two not-yet-attention statuses, no archived one.
    const progress = clientModule.FILTER_GROUPS.find((group) => group.id === 'progress')
    assert.deepEqual(progress.statuses, ['open', 'working'])
    // Each grouped status belongs to exactly one tab (done/void live only in `all`).
    const grouped = clientModule.FILTER_GROUPS
      .filter((group) => group.statuses !== null)
      .flatMap((group) => group.statuses)
    assert.deepEqual([...grouped].sort(), ['blocked', 'open', 'proposed', 'review', 'working'])
    assert.equal(new Set(grouped).size, grouped.length, 'no status is covered by two tabs')
  })
})

describe('todo panel rendering', () => {
  it('renders without throwing with no state yet', () => {
    const clientModule = loadClientModule()
    const tree = clientModule.TodoPage()
    assert.equal(tree.type, 'div')
    assert.match(tree.props.className, /todoPage/)
    const rendered = texts(tree).join(' | ')
    assert.match(rendered, /待办 Todo/)
    assert.match(rendered, /项目/)
    assert.match(rendered, /全局/)
    assert.match(rendered, /＋ 手动添加/)
    assert.match(rendered, /这里还没有待办。/)
    // Both level tabs start disabled until the first state arrives.
    const tabs = elements(tree, 'button').filter((button) => button.props.className === 'todoTab')
    assert.ok(tabs.length >= 2)
    const projectTab = tabs.find((tab) => texts(tab).includes('项目'))
    assert.equal(projectTab.props.disabled, true)
  })

  it('renders the fetched todos with their status labels and actions', async () => {
    const clientModule = loadClientModule()
    const requests = []
    const previousFetch = globalThis.fetch
    const cwd = 'D:\\work\\proj'
    const at = '2026-05-01T00:00:00.000Z'
    /**
     * One realistic `/state` payload: a proposed row the user must accept and an
     * open row that can be handed to the model.
     * @param {string} id - todo id.
     * @param {object} row - the row's own fields.
     */
    const summary = (id, row) => ({
      id,
      scope: 'project',
      preview: '',
      acceptance: '',
      tags: [],
      question: null,
      answerCount: 0,
      submission: null,
      accepted: null,
      approval: null,
      completion: null,
      voided: null,
      at,
      updatedAt: at,
      ...row,
    })
    const payload = {
      level: 'both',
      defaultScope: 'project',
      cwd,
      projectRoot: cwd,
      current: { source: 'manual', path: cwd, projectRoot: cwd },
      projects: [],
      statuses: ['proposed', 'open', 'working', 'blocked', 'review', 'done', 'void'],
      canDeliver: true,
      levels: {
        global: { scope: 'global', enabled: true, dir: 'D:\\home\\todo', file: 'D:\\home\\todo\\todos.jsonl', total: 0, counts: {}, todos: [] },
        project: {
          scope: 'project',
          enabled: true,
          dir: 'D:\\work\\proj\\.dsh\\todo',
          file: 'D:\\work\\proj\\.dsh\\todo\\todos.jsonl',
          total: 2,
          counts: { proposed: 1, open: 1, review: 0, blocked: 0, working: 0, done: 0, void: 0 },
          todos: [
            summary('p-proposed', { title: 'Add dark mode', status: 'proposed', priority: 'normal', origin: 'ai', actions: ['accept', 'complete', 'update', 'void'] }),
            summary('p-open', { title: 'Write the tests', status: 'open', priority: 'high', origin: 'user', actions: ['request', 'complete', 'update', 'void'] }),
          ],
        },
      },
    }
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), headers: options?.headers ?? {} })
      return { ok: true, status: 200, json: async () => payload }
    }
    clientModule.activeSession.id = null
    clientModule.activeSession.cwd = null
    const mount = createMount(clientModule.TodoPage)
    try {
      const tree = await mount.settle()

      // The one-shot load effect fetched once, with the marker header.
      assert.equal(requests.length, 1)
      assert.match(decodeURIComponent(requests[0].url), /limit=0/)
      assert.equal(requests[0].headers[CLIENT_HEADER], '1')

      const rendered = texts(tree).join(' | ')
      assert.match(rendered, /Write the tests/)
      assert.match(rendered, /Add dark mode/)
      // The proposed row is labelled as waiting and offers the accept action.
      assert.match(rendered, /待你接受/)
      assert.match(rendered, /确认接受/)
      // The toolbar is three group tabs, not one tab per status.
      const filterTabs = elements(tree, 'button')
        .filter((button) => button.props.className === 'todoTab')
        .map((button) => texts(button).join(''))
      assert.equal(filterTabs.length, 5, filterTabs.join(' | '))
      for (const label of ['待我处理1', '进行中1', '全部2']) assert.ok(filterTabs.includes(label), `missing tab ${label}: ${filterTabs.join(' | ')}`)
      // The open row offers the hand-off to the model.
      assert.match(rendered, /交给 AI 完成/)
      // Real state replaced the empty-state text.
      assert.equal(rendered.includes('这里还没有待办。'), false)
    } finally {
      mount.unmount()
      globalThis.fetch = previousFetch
      clientModule.activeSession.id = null
      clientModule.activeSession.cwd = null
    }
  })

  it('names the expanded row\'s edit action 编辑待办', async () => {
    const clientModule = loadClientModule()
    const previousFetch = globalThis.fetch
    const cwd = 'D:\\work\\proj'
    const at = '2026-05-01T00:00:00.000Z'
    const summary = (id, row) => ({
      id,
      scope: 'project',
      preview: '',
      acceptance: '',
      tags: [],
      question: null,
      answerCount: 0,
      submission: null,
      accepted: null,
      approval: null,
      completion: null,
      voided: null,
      at,
      updatedAt: at,
      ...row,
    })
    const row = summary('p-open', { title: 'Write the tests', status: 'open', priority: 'high', origin: 'user', actions: ['request', 'complete', 'update', 'void'] })
    const payload = {
      level: 'both',
      defaultScope: 'project',
      cwd,
      projectRoot: cwd,
      current: { source: 'manual', path: cwd, projectRoot: cwd },
      projects: [],
      statuses: ['proposed', 'open', 'working', 'blocked', 'review', 'done', 'void'],
      canDeliver: false,
      levels: {
        global: { scope: 'global', enabled: true, dir: 'D:\\home\\todo', file: 'D:\\home\\todo\\todos.jsonl', total: 0, counts: {}, todos: [] },
        project: {
          scope: 'project',
          enabled: true,
          dir: `${cwd}\\.dsh\\todo`,
          file: `${cwd}\\.dsh\\todo\\todos.jsonl`,
          total: 1,
          counts: { open: 1 },
          todos: [row],
        },
      },
    }
    globalThis.fetch = async (url) => {
      const address = String(url)
      if (/\/todo\?/.test(address)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, todo: { ...row, detail: '覆盖三个分支', acceptance: '测试通过', projectRoot: cwd, answers: [], history: [], file: payload.levels.project.file } }),
        }
      }
      return { ok: true, status: 200, json: async () => payload }
    }
    clientModule.activeSession.id = null
    clientModule.activeSession.cwd = null
    const mount = createMount(clientModule.TodoPage)
    try {
      let tree = await mount.settle()
      // The collapsed row never offered the edit action, so the new label is
      // exclusively the expanded detail action.
      assert.equal(texts(tree).includes('编辑待办'), false)

      const head = elements(tree, 'div').find((node) => node.props.className === 'todoItemHead')
      assert.ok(head !== undefined, 'the row head is what expands the detail')
      head.props.onClick()
      tree = await mount.settle()

      const labels = elements(tree, 'button').map((button) => texts(button).join(''))
      assert.ok(labels.includes('编辑待办'), `missing 编辑待办: ${labels.join(' | ')}`)
      // The old label named the detail section instead of what the button edits.
      assert.equal(texts(tree).includes('编辑详情'), false)
    } finally {
      mount.unmount()
      globalThis.fetch = previousFetch
      clientModule.activeSession.id = null
      clientModule.activeSession.cwd = null
    }
  })

  it('labels every field in the manual-add form too', async () => {
    const clientModule = loadClientModule()
    const previousFetch = globalThis.fetch
    const cwd = 'D:\\work\\proj'
    const payload = {
      level: 'both',
      defaultScope: 'project',
      cwd,
      projectRoot: cwd,
      current: { source: 'manual', path: cwd, projectRoot: cwd },
      projects: [],
      statuses: ['proposed', 'open', 'working', 'blocked', 'review', 'done', 'void'],
      canDeliver: false,
      levels: {
        global: { scope: 'global', enabled: true, total: 0, counts: {}, todos: [] },
        project: { scope: 'project', enabled: true, dir: `${cwd}\\.dsh\\todo`, file: `${cwd}\\.dsh\\todo\\todos.jsonl`, total: 0, counts: {}, todos: [] },
      },
    }
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload })
    clientModule.activeSession.id = null
    clientModule.activeSession.cwd = null
    const mount = createMount(clientModule.TodoPage)
    try {
      let tree = await mount.settle()
      const toggle = elements(tree, 'button').find((button) => texts(button).join('') === '＋ 手动添加')
      assert.ok(toggle !== undefined, 'the toolbar opens the composer')
      toggle.props.onClick()
      tree = await mount.settle()

      const labels = elements(tree, 'label').filter((label) => label.props.className === 'todoFieldLabel')
      assert.deepEqual(labels.map((label) => texts(label).join('')).sort(), ['优先级', '标签', '标题', '详细说明', '验收标准'].sort())
      const controls = [...elements(tree, 'input'), ...elements(tree, 'textarea'), ...elements(tree, 'select')]
      for (const label of labels) {
        const control = controls.find((node) => node.props.id === label.props.htmlFor)
        assert.ok(control !== undefined, `缺少与标签「${texts(label).join('')}」关联的输入框`)
      }

      // Typing in a box keeps every label: the field's name must not depend on
      // the placeholder being visible.
      const title = controls.find((node) => node.props.id === 'todo-add-title')
      title.props.onChange({ target: { value: '一条新待办' } })
      tree = await mount.settle()
      const typed = elements(tree, 'input').find((node) => node.props.id === 'todo-add-title')
      assert.equal(typed.props.value, '一条新待办')
      const stillLabelled = elements(tree, 'label')
        .filter((label) => label.props.className === 'todoFieldLabel')
        .map((label) => texts(label).join(''))
      assert.deepEqual(stillLabelled.sort(), ['优先级', '标签', '标题', '详细说明', '验收标准'].sort())
      // The add button still says where the todo will land.
      assert.ok(elements(tree, 'button').some((button) => texts(button).join('') === '添加到项目'))
    } finally {
      mount.unmount()
      globalThis.fetch = previousFetch
      clientModule.activeSession.id = null
      clientModule.activeSession.cwd = null
    }
  })

  it('labels every edit field so a filled form still says what each box is', async () => {
    const clientModule = loadClientModule()
    const previousFetch = globalThis.fetch
    const cwd = 'D:\\work\\proj'
    const at = '2026-05-01T00:00:00.000Z'
    const summary = (id, row) => ({
      id,
      scope: 'project',
      preview: '',
      acceptance: '',
      tags: [],
      question: null,
      answerCount: 0,
      submission: null,
      accepted: null,
      approval: null,
      completion: null,
      voided: null,
      at,
      updatedAt: at,
      ...row,
    })
    const row = summary('p-open', { title: 'Write the tests', status: 'open', priority: 'high', origin: 'user', tags: ['ui'], actions: ['request', 'complete', 'update', 'void'] })
    const file = `${cwd}\\.dsh\\todo\\todos.jsonl`
    const record = { ...row, detail: '覆盖三个分支', acceptance: '测试通过', projectRoot: cwd, answers: [], history: [], file }
    const payload = {
      level: 'both',
      defaultScope: 'project',
      cwd,
      projectRoot: cwd,
      current: { source: 'manual', path: cwd, projectRoot: cwd },
      projects: [],
      statuses: ['proposed', 'open', 'working', 'blocked', 'review', 'done', 'void'],
      canDeliver: false,
      levels: {
        global: { scope: 'global', enabled: true, dir: 'D:\\home\\todo', file: 'D:\\home\\todo\\todos.jsonl', total: 0, counts: {}, todos: [] },
        project: {
          scope: 'project',
          enabled: true,
          dir: `${cwd}\\.dsh\\todo`,
          file,
          total: 1,
          counts: { open: 1 },
          todos: [row],
        },
      },
    }
    globalThis.fetch = async (url) => {
      if (/\/todo\?/.test(String(url))) return { ok: true, status: 200, json: async () => ({ ok: true, todo: record }) }
      return { ok: true, status: 200, json: async () => payload }
    }
    clientModule.activeSession.id = null
    clientModule.activeSession.cwd = null
    const mount = createMount(clientModule.TodoPage)
    try {
      let tree = await mount.settle()
      const head = elements(tree, 'div').find((node) => node.props.className === 'todoItemHead')
      assert.ok(head !== undefined, 'the row head expands the detail')
      head.props.onClick()
      tree = await mount.settle()
      const edit = elements(tree, 'button').find((button) => texts(button).join('') === '编辑待办')
      assert.ok(edit !== undefined, 'the expanded row offers the edit action')
      edit.props.onClick({})
      tree = await mount.settle()

      // Every edit control is named by a visible <label>, not by a placeholder
      // that disappears as soon as the box has content.
      const labels = elements(tree, 'label').filter((label) => label.props.className === 'todoFieldLabel')
      assert.deepEqual(labels.map((label) => texts(label).join('')).sort(), ['优先级', '标签', '标题', '详细说明', '验收标准'].sort())
      const controls = [...elements(tree, 'input'), ...elements(tree, 'textarea'), ...elements(tree, 'select')]
      for (const label of labels) {
        const control = controls.find((node) => node.props.id === label.props.htmlFor)
        assert.ok(control !== undefined, `缺少与标签「${texts(label).join('')}」关联的输入框`)
      }

      // The filled-in values are still there, each under its own label.
      const byId = (field) => controls.find((node) => node.props.id === `todo-edit-p-open-${field}`)
      assert.equal(byId('title').props.value, 'Write the tests')
      assert.equal(byId('detail').props.value, '覆盖三个分支')
      assert.equal(byId('acceptance').props.value, '测试通过')
      assert.equal(byId('tags').props.value, 'ui')
      assert.equal(byId('priority').props.value, 'high')
      // Saving and cancelling stay available next to the labelled fields.
      const buttons = elements(tree, 'button').map((button) => texts(button).join(''))
      assert.ok(buttons.includes('保存'))
      assert.ok(buttons.includes('取消'))
    } finally {
      mount.unmount()
      globalThis.fetch = previousFetch
      clientModule.activeSession.id = null
      clientModule.activeSession.cwd = null
    }
  })

  it('offers a session picker for the hand-off and sends to the picked conversation', async () => {
    const clientModule = loadClientModule()
    const requests = []
    const previousFetch = globalThis.fetch
    const cwd = 'D:\\work\\proj'
    const otherRoot = 'D:\\work\\other'
    const at = '2026-05-01T00:00:00.000Z'
    const summary = (id, row) => ({
      id,
      scope: 'project',
      preview: '',
      acceptance: '',
      tags: [],
      question: null,
      answerCount: 0,
      submission: null,
      accepted: null,
      approval: null,
      completion: null,
      voided: null,
      at,
      updatedAt: at,
      ...row,
    })
    const level = {
      scope: 'project',
      enabled: true,
      dir: cwd,
      file: `${cwd}\\.dsh\\todo\\todos.jsonl`,
      total: 1,
      counts: { proposed: 0, open: 1, review: 0, blocked: 0, working: 0, done: 0, void: 0 },
      todos: [summary('p-open', { title: 'Write the tests', status: 'open', priority: 'high', origin: 'user', actions: ['request', 'complete', 'update', 'void'] })],
    }
    const state = {
      level: 'both',
      defaultScope: 'project',
      cwd,
      projectRoot: cwd,
      current: { source: 'manual', path: cwd, projectRoot: cwd },
      projects: [{ path: otherRoot, title: 'other' }],
      statuses: ['proposed', 'open', 'working', 'blocked', 'review', 'done', 'void'],
      canDeliver: true,
      levels: { global: { scope: 'global', enabled: true, total: 0, counts: {}, todos: [] }, project: level },
    }
    const sessions = {
      ok: true,
      canList: true,
      canCreate: true,
      current: 's-current',
      projectRoot: cwd,
      sessions: [
        { id: 's-current', title: '当前对话', cwd, projectRoot: cwd, updatedAt: 1, running: false, agentAvailable: true, blank: false, sameProject: true },
        { id: 's-other', title: '另一个对话', cwd: otherRoot, projectRoot: otherRoot, updatedAt: 2, running: true, agentAvailable: true, blank: false, sameProject: false },
        { id: 's-gone', title: '旧对话', cwd, projectRoot: cwd, updatedAt: 3, running: false, agentAvailable: false, blank: false, sameProject: true },
      ],
    }
    globalThis.fetch = async (url, options) => {
      const address = String(url)
      requests.push({ url: decodeURIComponent(address), method: options?.method ?? 'GET', body: options?.body === undefined ? undefined : JSON.parse(options.body) })
      if (address.includes('/request')) return { ok: true, status: 200, json: async () => ({ ...level, ok: true, delivered: true, sessionId: 's-other', created: false, target: 'session' }) }
      if (address.includes('/sessions')) return { ok: true, status: 200, json: async () => sessions }
      // `/todo?id=...`: the record fetch. Match the route, not the `/todo` prefix
      // every route shares (`api/todo/state` contains it too).
      if (/\/todo\?/.test(address)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, todo: { ...level.todos[0], detail: '覆盖三个分支', acceptance: '测试通过', projectRoot: cwd, answers: [], history: [], file: level.file } }),
        }
      }
      return { ok: true, status: 200, json: async () => state }
    }
    clientModule.activeSession.id = 's-current'
    clientModule.activeSession.cwd = cwd
    const mount = createMount(clientModule.TodoPage)
    try {
      let tree = await mount.settle()
      const handoff = elements(tree, 'button').find((button) => texts(button).includes('交给 AI 完成'))
      assert.ok(handoff !== undefined, 'the open row offers the hand-off')
      handoff.props.onClick({ stopPropagation() {} })
      tree = await mount.settle()

      // The picker lists the current conversation, a new one, and the other sessions.
      const picker = texts(tree).join(' | ')
      assert.match(picker, /投递到哪个会话/)
      assert.match(picker, /当前会话（当前对话）/)
      assert.match(picker, /新建会话/)
      assert.match(picker, /另一个对话 · 运行中/)
      assert.match(picker, /旧对话 · 同项目 · 需恢复/)
      assert.match(picker, /发送到会话/)
      // It asked the host for the session list with the panel's own session set.
      const listed = requests.find((request) => request.url.includes('/sessions'))
      assert.ok(listed !== undefined, 'the picker fetched /sessions')
      assert.ok(listed.url.includes('session=s-current'), listed.url)

      // Pick another conversation and send.
      const target = elements(tree, 'select').find((select) => texts(select).includes('新建会话'))
      assert.ok(target !== undefined, 'the picker has a target select')
      target.props.onChange({ target: { value: 'session:s-other' } })
      tree = await mount.settle()
      const send = elements(tree, 'button').find((button) => texts(button).includes('发送到会话'))
      send.props.onClick({})
      tree = await mount.settle()

      const posted = requests.find((request) => request.method === 'POST' && request.url.includes('/request'))
      assert.ok(posted !== undefined, 'the hand-off was posted')
      assert.equal(posted.body.target, 'session')
      assert.equal(posted.body.targetSession, 's-other')
      assert.equal(posted.body.id, 'p-open')
      assert.equal(posted.body.scope, 'project')
      assert.equal(posted.body.session, 's-current', 'the panel still reports the session it is in')
      assert.match(texts(tree).join(' | '), /已把这条待办交给 AI/)
    } finally {
      mount.unmount()
      globalThis.fetch = previousFetch
      clientModule.activeSession.id = null
      clientModule.activeSession.cwd = null
    }
  })
})

describe('todo client contract', () => {
  it('speaks the same contract as the host API', async () => {
    const source = await readFile(CLIENT_PATH, 'utf8')
    assert.ok(source.includes(CLIENT_HEADER), 'sends the marker header')
    assert.ok(source.includes('api/todo'), 'talks to the host route prefix')
    for (const route of ['/state', '/todo', '/todos', '/action', '/request']) {
      assert.ok(source.includes(route), `bundle calls ${route}`)
    }
    assert.equal(API_PREFIX, '/api/todo')
  })
})
