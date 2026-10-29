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
/** The loader keys browser modules by package name; registration must match it exactly. */
const PACKAGE_NAME = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).name

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
    assert.equal(page.registration.id, PACKAGE_NAME)
    assert.equal(typeof page.registration.factory, 'function')
    // The module system claims untagged <style> tags present when the factory
    // returns, so the stylesheet must be inserted while it runs.
    assert.equal(page.appended.length, 1)
    const style = page.appended[0]
    assert.equal(style.dataset.plugin, PACKAGE_NAME)
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

  it('summarizes every project, keeping the current one first and live', () => {
    const clientModule = loadClientModule()
    const state = {
      current: { source: 'manual', path: 'D:\\work\\b' },
      projects: [
        { path: 'D:\\work\\b', title: 'b', total: 1, attention: 0 },
        { path: 'D:\\work\\a', title: 'a', total: 2, attention: 2 },
        { path: 'D:\\work\\c', title: 'c', total: 0, attention: 0 },
      ],
      levels: {
        // The live project level is authoritative for the current project: it is
        // the copy mutations refresh, so the chip never lags behind an action.
        project: { enabled: true, total: 4, counts: { proposed: 1, review: 0, blocked: 1, open: 2 } },
      },
    }
    assert.deepEqual(clientModule.projectOverview(state), [
      { path: 'D:\\work\\b', title: 'b', current: true, projectRoot: 'D:\\work\\b', total: 4, attention: 2 },
      { path: 'D:\\work\\a', title: 'a', current: false, projectRoot: 'D:\\work\\a', total: 2, attention: 2 },
      { path: 'D:\\work\\c', title: 'c', current: false, projectRoot: 'D:\\work\\c', total: 0, attention: 0 },
    ])
    // Before the first load there is nothing to summarize.
    assert.deepEqual(clientModule.projectOverview(null), [])
    assert.deepEqual(clientModule.projectOverview(undefined), [])

    // The project the panel is addressing is listed even when it is not a
    // registered workspace, labelled as the session's project.
    assert.deepEqual(clientModule.projectOverview({
      current: { source: 'session', path: 'D:\\files\\projects\\trusted_data' },
      projects: [],
      levels: { project: { enabled: true, total: 3, counts: { open: 3 } } },
    }), [{
      path: 'D:\\files\\projects\\trusted_data',
      title: 'trusted_data（当前会话）',
      current: true,
      projectRoot: 'D:\\files\\projects\\trusted_data',
      total: 3,
      attention: 0,
    }])

    // A disabled project level cannot refresh the live numbers, so the row keeps
    // what the server reported.
    assert.deepEqual(clientModule.projectOverview({
      current: { source: 'manual', path: 'D:\\work\\b' },
      projects: [{ path: 'D:\\work\\b', title: 'b', total: 2, attention: 1 }],
      levels: { project: { enabled: false, total: 0, counts: {} } },
    })[0], { path: 'D:\\work\\b', title: 'b', current: true, projectRoot: 'D:\\work\\b', total: 2, attention: 1 })

    // A registry row that repeats the current project never renders a second chip.
    assert.equal(clientModule.projectOverview({
      current: { source: 'manual', path: 'D:\\work\\b' },
      projects: [{ path: 'D:\\work\\b', title: 'b', total: 1 }, { path: 'D:\\work\\b', title: 'b', total: 1 }],
      levels: { project: { enabled: true, total: 1, counts: { open: 1 } } },
    }).length, 1)

    // Workspaces nested in one project root share that project's todo file, so
    // they share one chip rather than showing the same count twice.
    assert.deepEqual(clientModule.projectOverview({
      current: { source: 'manual', path: 'D:\\work\\b' },
      projects: [
        { path: 'D:\\work\\repo', title: 'repo', projectRoot: 'D:\\work\\repo', total: 2, attention: 1 },
        { path: 'D:\\work\\repo\\packages', title: 'pkg', projectRoot: 'D:\\work\\repo', total: 2, attention: 1 },
      ],
      levels: { project: { enabled: false, total: 0, counts: {} } },
    }).map((row) => row.path), ['D:\\work\\b', 'D:\\work\\repo'])
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
    // Reopening a started todo is not the same promise as reopening an archived
    // one: it sends the todo back to the queue, so it says so.
    assert.equal(clientModule.actionLabel({ status: 'working' }, 'reopen'), '重开待办')
    assert.equal(clientModule.actionLabel({ status: 'blocked' }, 'reopen'), '重开待办')
    assert.equal(clientModule.actionLabel({ status: 'void' }, 'reopen'), '重新打开')
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
      // The overview now carries the counts under the title. With only the
      // current project holding todos it still shows that project and the global
      // list, so the two totals never disappear from the page.
      const projectChips = elements(tree, 'button').filter((button) => button.props.className === 'todoProject')
      assert.deepEqual(projectChips.map((chip) => texts(chip).join(' ')), ['proj（当前会话） 2 1 待处理', '全局 0'])
      // The header keeps just the call to action; the strip owns the totals.
      assert.match(rendered, /需要你处理 1 条/)
      assert.equal(rendered.includes('项目共'), false)
      assert.equal(rendered.includes('全局共'), false)
    } finally {
      mount.unmount()
      globalThis.fetch = previousFetch
      clientModule.activeSession.id = null
      clientModule.activeSession.cwd = null
    }
  })

  it('shows the project and global counts under the title, and switches scope on click', async () => {
    const clientModule = loadClientModule()
    const requests = []
    const previousFetch = globalThis.fetch
    const cwd = 'D:\\work\\proj'
    const other = 'D:\\work\\other'
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
    /** One `/state` payload, with `projects` carrying each project's counts. */
    const statePayload = (currentPath, level) => ({
      level: 'both',
      defaultScope: 'project',
      cwd: currentPath,
      projectRoot: currentPath,
      current: { source: 'manual', path: currentPath, projectRoot: currentPath },
      projects: [
        { path: cwd, title: 'proj', projectRoot: cwd, enabled: true, total: 1, attention: 0 },
        { path: other, title: 'other', projectRoot: other, enabled: true, total: 2, attention: 1 },
        { path: 'D:\\work\\empty', title: 'empty', projectRoot: 'D:\\work\\empty', enabled: true, total: 0, attention: 0 },
      ],
      statuses: ['proposed', 'open', 'working', 'blocked', 'review', 'done', 'void'],
      canDeliver: false,
      levels: {
        // The global list is shared by every project; it belongs on the same
        // overview as the projects, not only in the header line.
        global: {
          scope: 'global',
          enabled: true,
          total: 3,
          counts: { proposed: 1, done: 2 },
          todos: [summary('g-one', {
            scope: 'global',
            title: 'shared task',
            status: 'proposed',
            priority: 'normal',
            origin: 'ai',
            actions: ['accept', 'complete', 'update', 'void'],
          })],
        },
        project: {
          scope: 'project',
          enabled: true,
          dir: `${currentPath}\\.dsh\\todo`,
          file: `${currentPath}\\.dsh\\todo\\todos.jsonl`,
          total: level.total,
          counts: level.counts,
          todos: level.todos ?? [],
        },
      },
    })
    const first = statePayload(cwd, {
      total: 1,
      counts: { open: 1 },
      todos: [summary('p-one', { title: 'local task', status: 'open', priority: 'normal', origin: 'user', actions: ['request', 'complete', 'update', 'void'] })],
    })
    const second = statePayload(other, {
      total: 2,
      counts: { proposed: 1, open: 1 },
      todos: [summary('p-two', { title: 'other task', status: 'proposed', priority: 'normal', origin: 'ai', actions: ['accept', 'complete', 'update', 'void'] })],
    })
    globalThis.fetch = async (url) => {
      const address = decodeURIComponent(String(url))
      requests.push(address)
      return { ok: true, status: 200, json: async () => (address.includes(`project=${other}`) ? second : first) }
    }
    clientModule.activeSession.id = null
    clientModule.activeSession.cwd = null
    const mount = createMount(clientModule.TodoPage)
    try {
      let tree = await mount.settle()
      const chips = () => elements(tree, 'button').filter((button) => button.props.className === 'todoProject')
      assert.deepEqual(chips().map((chip) => texts(chip).join(' ')), ['proj 1', 'other 2 1 待处理', '全局 3 1 待处理'])
      // A project with no todos is not listed on the strip.
      assert.equal(chips().length, 3)
      assert.ok(chips().every((chip) => texts(chip).join('').includes('empty') === false))
      // The strip sits directly below the title, above both toolbars.
      const head = elements(tree, 'div').find((node) => node.props.className === 'todoHead')
      assert.deepEqual(
        head.children.slice(0, 3).map((child) => child.props.className),
        ['todoTitleRow', 'todoProjects', 'todoToolbar'],
      )
      // The dropdown names each project's count as well, so the choice is
      // informed even while the strip is collapsed out of the way.
      assert.deepEqual(elements(tree, 'option').map((option) => texts(option).join('')), [
        'proj · 1 条',
        'other · 2 条',
        'empty',
      ])

      // Clicking another project asks the API for that project.
      chips()[1].props.onClick()
      tree = await mount.settle()
      assert.ok(requests.some((address) => address.includes(`project=${other}`)), requests.join(' | '))
      // The clicked project is now the current chip and reads its fresh level.
      assert.deepEqual(chips().map((chip) => chip.props['data-active']), ['true', 'false', 'false'])
      assert.equal(texts(chips()[0]).join(' '), 'other 2 1 待处理')

      // The global chip switches to the list every project shares.
      chips()[2].props.onClick()
      tree = await mount.settle()
      assert.deepEqual(chips().map((chip) => chip.props['data-active']), ['false', 'false', 'true'])
      assert.match(texts(tree).join(' | '), /shared task/)
      assert.equal(texts(tree).join(' | ').includes('other task'), false)
      assert.equal(requests.length, 2, 'switching scope reuses the levels already loaded')
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

  it('stops offering the hand-off once the model has the todo', async () => {
    const clientModule = loadClientModule()
    const previousFetch = globalThis.fetch
    const cwd = 'D:\\work\\proj'
    const at = '2026-05-01T00:00:00.000Z'
    const file = `${cwd}\\.dsh\\todo\\todos.jsonl`
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
    // `working` and `blocked` mirror what the host now sends: no `request`, so no
    // hand-off, but a `reopen` back to the queue.
    const rows = [
      summary('p-working', { title: 'AI 正在做', status: 'working', priority: 'normal', origin: 'user', actions: ['complete', 'update', 'reopen', 'void'] }),
      summary('p-blocked', { title: '等你说清楚', status: 'blocked', priority: 'normal', origin: 'user', question: '要哪个环境？', actions: ['answer', 'complete', 'update', 'reopen', 'void'] }),
      summary('p-open', { title: '还没开工', status: 'open', priority: 'normal', origin: 'user', actions: ['request', 'complete', 'update', 'void'] }),
    ]
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
        project: { scope: 'project', enabled: true, dir: `${cwd}\\.dsh\\todo`, file, total: rows.length, counts: { working: 1, blocked: 1, open: 1 }, todos: rows },
      },
    }
    globalThis.fetch = async (url) => {
      const address = decodeURIComponent(String(url))
      if (/\/todo\?/.test(address)) {
        const id = address.match(/[?&]id=([^&]+)/)?.[1]
        const row = rows.find((candidate) => candidate.id === id) ?? rows[0]
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, todo: { ...row, detail: '详情', acceptance: '验收', projectRoot: cwd, answers: [], history: [], file } }),
        }
      }
      return { ok: true, status: 200, json: async () => payload }
    }
    clientModule.activeSession.id = null
    clientModule.activeSession.cwd = null
    const mount = createMount(clientModule.TodoPage)
    try {
      let tree = await mount.settle()
      const labels = () => elements(tree, 'button').map((button) => texts(button).join(''))
      const handoffs = () => labels().filter((label) => label === '交给 AI 完成')
      const headOf = (title) => elements(tree, 'div')
        .find((node) => node.props.className === 'todoItemHead' && texts(node).join(' ').includes(title))

      // Only the todo nobody has started yet offers the hand-off.
      assert.equal(handoffs().length, 1, 'only an open row offers the hand-off')
      // A started todo offers the way back to the queue instead.
      assert.equal(labels().filter((label) => label === '重开待办').length, 2, 'working and blocked both offer 重开待办')

      for (const title of ['AI 正在做', '等你说清楚']) {
        const head = headOf(title)
        assert.ok(head !== undefined, `the ${title} row is rendered`)
        head.props.onClick()
        tree = await mount.settle()
        // The detail toolbar used to keep its own status list and re-offer the
        // hand-off here; it now reads the same action list as the row.
        assert.equal(handoffs().length, 1, `the expanded ${title} row must not offer the hand-off`)
      }

      const openHead = headOf('还没开工')
      assert.ok(openHead !== undefined, 'the open row is rendered')
      openHead.props.onClick()
      tree = await mount.settle()
      // The row plus the expanded detail: the hand-off is still reachable where
      // it is legal, so the fix did not remove the button outright.
      assert.equal(handoffs().length, 2, 'an open todo keeps both hand-off entries')
    } finally {
      mount.unmount()
      globalThis.fetch = previousFetch
      clientModule.activeSession.id = null
      clientModule.activeSession.cwd = null
    }
  })

  it('confirms before sending a started todo back to the queue', async () => {
    const clientModule = loadClientModule()
    const previousFetch = globalThis.fetch
    // The module's `before` hook removes the page stubs again; the confirm dialog
    // is only reachable when a `window` exists, so this test installs one.
    const previousWindow = globalThis.window
    const cwd = 'D:\\work\\proj'
    const at = '2026-05-01T00:00:00.000Z'
    const file = `${cwd}\\.dsh\\todo\\todos.jsonl`
    const row = {
      id: 'p-working',
      scope: 'project',
      title: 'AI 正在做',
      status: 'working',
      priority: 'normal',
      origin: 'user',
      tags: [],
      preview: '',
      acceptance: '',
      question: null,
      answerCount: 0,
      submission: null,
      accepted: null,
      approval: null,
      completion: null,
      voided: null,
      at,
      updatedAt: at,
      actions: ['complete', 'update', 'reopen', 'void'],
    }
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
        project: { scope: 'project', enabled: true, dir: `${cwd}\\.dsh\\todo`, file, total: 1, counts: { working: 1 }, todos: [row] },
      },
    }
    const posted = []
    globalThis.fetch = async (url, options) => {
      const address = decodeURIComponent(String(url))
      if (options?.method === 'POST' && address.includes('/action')) posted.push(JSON.parse(options.body))
      if (/\/todo\?/.test(address)) {
        return { ok: true, status: 200, json: async () => ({ ok: true, todo: { ...row, detail: '', acceptance: '', projectRoot: cwd, answers: [], history: [], file } }) }
      }
      return { ok: true, status: 200, json: async () => payload }
    }
    clientModule.activeSession.id = null
    clientModule.activeSession.cwd = null
    const mount = createMount(clientModule.TodoPage)
    const asked = []
    try {
      globalThis.window = { confirm: (message) => { asked.push(message); return false } }
      let tree = await mount.settle()
      const reopen = elements(tree, 'button').find((button) => texts(button).join('') === '重开待办')
      assert.ok(reopen !== undefined, 'the working row offers 重开待办')
      reopen.props.onClick({ stopPropagation() {} })
      tree = await mount.settle()
      // Declining keeps the todo where it is, and says why it asked.
      assert.equal(posted.length, 0, 'a refused confirmation sends nothing')
      assert.match(asked[0], /重开待办：AI 正在做/)
      assert.match(asked[0], /清掉 AI 的进展与提问/)

      globalThis.window = { confirm: () => true }
      elements(tree, 'button').find((button) => texts(button).join('') === '重开待办').props.onClick({ stopPropagation() {} })
      tree = await mount.settle()
      assert.equal(posted.length, 1)
      assert.equal(posted[0].action, 'reopen')
      assert.equal(posted[0].id, 'p-working')
    } finally {
      mount.unmount()
      globalThis.fetch = previousFetch
      if (previousWindow === undefined) delete globalThis.window
      else globalThis.window = previousWindow
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
