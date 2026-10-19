/**
 * Hand-off target tests: which conversation a todo goes to.
 *
 * The panel lets the user pick the conversation instead of always using the one
 * they happen to be sitting in, and a global todo also picks where the work
 * happens (a project-level todo already belongs to one). That decision lives in
 * three places, all covered here:
 *
 * - `lib/api.js` `GET /sessions` and `POST /request {target}`,
 * - `lib/index.js` `listSessions` / `createSession` / `deliverToAgent`,
 * - `lib/client.js` the pure picker helpers.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { API_PREFIX, CLIENT_HEADER, createTodoApi } from '../lib/api.js'
import { createSession, deliverToAgent, listSessions, resolveOptions } from '../lib/index.js'
import { TodoStore } from '../lib/store.js'

const root = await mkdtemp(join(tmpdir(), 'todo-targets-'))
const project = join(root, 'projects')
before(async () => { await mkdir(project, { recursive: true }) })
after(async () => { await rm(root, { recursive: true, force: true }) })

/**
 * Build an API over real stores with the session capabilities under test.
 * @param {string} name - subdirectory that isolates this test's todos.
 * @param {object} [options] - capability overrides.
 * @returns {object} the harness.
 */
function makeApi(name, { level = 'both', defaultScope = 'project', projects = [], sessions = {}, listSessions: list, createSession: create, deliverRequest } = {}) {
  const stores = new Map()
  const storeFor = (cwd) => {
    let store = stores.get(cwd)
    if (store === undefined) {
      store = new TodoStore({ cwd, level, defaultScope, dshHome: root, globalDir: join(cwd, '.global'), projectRootMarkers: [] })
      stores.set(cwd, store)
    }
    return store
  }
  const api = createTodoApi({
    storeFor,
    listProjects: () => projects,
    resolveSessionCwd: (sessionId) => sessions[sessionId],
    listSessions: list,
    createSession: create,
    deliverRequest,
  })
  const cwd = join(project, name)
  return {
    cwd,
    storeFor,
    seed: async (items, { origin = 'user', scope = 'project' } = {}) => (await storeFor(cwd).create({ items, origin, scope })).todos,
    send: (method, route, { body, query, headers } = {}) => api.handle({
      method,
      pathname: `${API_PREFIX}${route}`,
      query,
      headers: { [CLIENT_HEADER]: '1', ...headers },
      body,
    }),
  }
}

describe('GET /sessions', () => {
  it('reports that sessions cannot be listed instead of failing', async () => {
    const api = makeApi('sessions-none')
    const answer = await api.send('GET', '/sessions', { query: { project: api.cwd, session: 's-panel' } })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.canList, false)
    assert.equal(answer.body.canCreate, false)
    assert.deepEqual(answer.body.sessions, [])
    assert.equal(answer.body.current, 's-panel')
    assert.equal(answer.body.projectRoot, api.cwd)
  })

  it('flags the sessions that live in the panel\'s project and filters by query', async () => {
    const asked = []
    const api = makeApi('sessions-list', {
      createSession: async () => ({ sessionId: 'new' }),
      listSessions: async (input) => {
        asked.push(input)
        return [
          { id: 's-1', title: '当前对话', cwd: api.cwd, projectRoot: api.cwd, updatedAt: 3, running: false, agentAvailable: true },
          { id: 's-2', title: '另一个项目', cwd: 'D:\\elsewhere', projectRoot: 'D:\\elsewhere', updatedAt: 2, running: true, agentAvailable: true },
        ]
      },
    })
    const all = await api.send('GET', '/sessions', { query: { project: api.cwd } })
    assert.equal(all.body.canList, true)
    assert.equal(all.body.canCreate, true)
    assert.deepEqual(asked, [{ limit: 25 }], 'the default limit reaches the host')
    assert.deepEqual(all.body.sessions.map((session) => session.sameProject), [true, false])
    assert.equal(all.body.sessions[0].title, '当前对话')

    const limited = await api.send('GET', '/sessions', { query: { project: api.cwd, limit: '5' } })
    assert.deepEqual(asked[1], { limit: 5 })

    const filtered = await api.send('GET', '/sessions', { query: { project: api.cwd, query: '另一个' } })
    assert.deepEqual(filtered.body.sessions.map((session) => session.id), ['s-2'])
    const byCwd = await api.send('GET', '/sessions', { query: { project: api.cwd, query: 'elsewhere' } })
    assert.deepEqual(byCwd.body.sessions.map((session) => session.id), ['s-2'])

    const bad = await api.send('GET', '/sessions', { query: { project: api.cwd, limit: '-1' } })
    assert.equal(bad.status, 400)
    const wrongVerb = await api.send('POST', '/sessions', { body: {} })
    assert.equal(wrongVerb.status, 405)
  })

  it('reports a session list that fails to load', async () => {
    const api = makeApi('sessions-boom', { listSessions: async () => { throw new Error('persistence offline') } })
    const answer = await api.send('GET', '/sessions', { query: { project: api.cwd } })
    assert.equal(answer.status, 502)
    assert.match(answer.body.error, /persistence offline/)
  })

  it('returns the todo\'s own project on the record, for a new session\'s cwd', async () => {
    const api = makeApi('record-root')
    const [todo] = await api.seed([{ title: 'one' }])
    const answer = await api.send('GET', '/todo', { query: { project: api.cwd, id: todo.id } })
    assert.equal(answer.body.todo.projectRoot, api.cwd)
  })
})

describe('POST /request target', () => {
  it('defaults to the conversation the panel is in', async () => {
    const delivered = []
    const api = makeApi('target-current', { deliverRequest: async (input) => { delivered.push(input); return { delivered: true } } })
    const [todo] = await api.seed([{ title: 'one' }])
    const answer = await api.send('POST', '/request', { body: { project: api.cwd, session: 's-panel', id: todo.id } })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.sessionId, 's-panel')
    assert.equal(answer.body.created, false)
    assert.equal(delivered[0].sessionId, 's-panel')
    assert.equal(answer.body.todos.find((row) => row.id === todo.id).status, 'working', 'the panel records the hand-off')

    const explicit = await api.send('POST', '/request', { body: { project: api.cwd, id: todo.id, target: 'current', session: 's-again' } })
    assert.equal(explicit.body.sessionId, 's-again')
  })

  it('delivers to an explicitly picked session, not the panel\'s own', async () => {
    const delivered = []
    const api = makeApi('target-session', {
      sessions: { 's-picked': 'D:\\work\\picked' },
      deliverRequest: async (input) => { delivered.push(input); return { delivered: true } },
    })
    const [todo] = await api.seed([{ title: 'one' }])
    const answer = await api.send('POST', '/request', {
      body: { project: api.cwd, session: 's-panel', id: todo.id, target: 'session', targetSession: 's-picked' },
    })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.target, 'session')
    assert.equal(answer.body.sessionId, 's-picked')
    assert.equal(delivered[0].sessionId, 's-picked')

    const missing = await api.send('POST', '/request', { body: { project: api.cwd, session: 's-panel', id: todo.id, target: 'session' } })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error, /targetSession/)

    const unknown = await api.send('POST', '/request', { body: { project: api.cwd, id: todo.id, target: 'somewhere' } })
    assert.equal(unknown.status, 400)
    assert.match(unknown.body.error, /unknown target/)
  })

  it('creates a session in the todo\'s own project for a project-level todo', async () => {
    const created = []
    const delivered = []
    const api = makeApi('target-new-project', {
      createSession: async (input) => { created.push(input); return { sessionId: 's-new' } },
      deliverRequest: async (input) => { delivered.push(input); return { delivered: true } },
    })
    const [todo] = await api.seed([{ title: 'one' }])
    const answer = await api.send('POST', '/request', { body: { project: api.cwd, session: 's-panel', id: todo.id, target: 'new' } })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.created, true)
    assert.equal(answer.body.sessionId, 's-new')
    assert.deepEqual(created, [{ cwd: api.cwd }], 'a project todo keeps its own project')
    assert.equal(delivered[0].sessionId, 's-new')
  })

  it('lets a global todo choose the project the new session runs in', async () => {
    const created = []
    const delivered = []
    const api = makeApi('target-new-global', {
      createSession: async (input) => { created.push(input); return { sessionId: 's-new' } },
      deliverRequest: async (input) => { delivered.push(input); return { delivered: true } },
    })
    const [todo] = await api.seed([{ title: 'global one' }], { scope: 'global' })
    const elsewhere = join(root, 'elsewhere')
    const answer = await api.send('POST', '/request', {
      body: { project: api.cwd, scope: 'global', id: todo.id, target: 'new', cwd: elsewhere },
    })
    assert.equal(answer.status, 200)
    assert.deepEqual(created, [{ cwd: elsewhere }], 'the chosen project is the new session\'s cwd')
    assert.match(delivered[0].prompt, new RegExp(`项目: ${elsewhere.replace(/[\\]/g, '\\\\')}`))

    // A global todo with no project at all still lands in the panel's project.
    await api.send('POST', '/request', { body: { project: api.cwd, scope: 'global', id: todo.id, target: 'new' } })
    assert.deepEqual(created[1], { cwd: api.cwd })
  })

  it('refuses a new session when it cannot be made, and reports why', async () => {
    const api = makeApi('target-new-refuse', { deliverRequest: async () => ({ delivered: true }) })
    const [todo] = await api.seed([{ title: 'one' }])
    const unsupported = await api.send('POST', '/request', { body: { project: api.cwd, id: todo.id, target: 'new' } })
    assert.equal(unsupported.status, 409)
    assert.match(unsupported.body.error, /cannot create sessions/)
    assert.ok(unsupported.body.prompt.includes(todo.id), 'the copyable prompt still comes back')

    const relative = makeApi('target-new-relative', { createSession: async () => ({ sessionId: 's' }), deliverRequest: async () => ({ delivered: true }) })
    const [relativeTodo] = await relative.seed([{ title: 'one' }], { scope: 'global' })
    const badCwd = await relative.send('POST', '/request', { body: { project: relative.cwd, scope: 'global', id: relativeTodo.id, target: 'new', cwd: 'relative/path' } })
    assert.equal(badCwd.status, 400)
    assert.match(badCwd.body.error, /absolute path/)

    const silent = makeApi('target-new-silent', { createSession: async () => undefined, deliverRequest: async () => ({ delivered: true }) })
    const [silentTodo] = await silent.seed([{ title: 'one' }])
    const refused = await silent.send('POST', '/request', { body: { project: silent.cwd, id: silentTodo.id, target: 'new' } })
    assert.equal(refused.status, 409)
    assert.match(refused.body.error, /refused to create a session/)

    const throwing = makeApi('target-new-throw', { createSession: async () => { throw new Error('no workspace') }, deliverRequest: async () => ({ delivered: true }) })
    const [throwingTodo] = await throwing.seed([{ title: 'one' }])
    const failed = await throwing.send('POST', '/request', { body: { project: throwing.cwd, id: throwingTodo.id, target: 'new' } })
    assert.equal(failed.status, 409)
    assert.match(failed.body.error, /no workspace/)
  })

  it('reports the session it created even when the delivery then fails', async () => {
    const api = makeApi('target-new-failed', {
      createSession: async () => ({ sessionId: 's-new' }),
      deliverRequest: async () => ({ delivered: false, reason: 'the agent refused it' }),
    })
    const [todo] = await api.seed([{ title: 'one' }])
    const answer = await api.send('POST', '/request', { body: { project: api.cwd, id: todo.id, target: 'new' } })
    assert.equal(answer.status, 409)
    assert.equal(answer.body.sessionId, 's-new')
    assert.equal(answer.body.created, true)
    assert.equal(answer.body.error, 'the agent refused it')
  })
})

describe('listSessions', () => {
  const options = resolveOptions({ projectRootMarkers: [] })

  /** A host stand-in whose session controller returns the given rows. */
  const hostWith = (rows, { throws = false } = {}) => ({
    get: (key) => (key === 'sessionController'
      ? { list: async () => { if (throws) throw new Error('offline'); return { items: rows } } }
      : undefined),
  })

  it('maps the host rows and drops subagent sessions', async () => {
    const ctx = hostWith([
      { sessionId: 's-1', cwd: 'D:\\work\\proj\\packages\\app', updatedAt: 9, running: true, agentAvailable: true, blank: false, projections: { values: { title: '  有标题  ' } } },
      { sessionId: 's-2', cwd: 'D:\\work\\other', updatedAt: 8, running: false, agentAvailable: false, blank: true },
      { sessionId: 's-3', cwd: 'D:\\work\\proj', updatedAt: 7, origin: 'subagent' },
      { sessionId: 's-4', cwd: 'D:\\work\\proj', updatedAt: 6, parentSessionId: 's-1' },
    ])
    const sessions = await listSessions(ctx, options, { limit: 10 })
    assert.deepEqual(sessions.map((session) => session.id), ['s-1', 's-2'])
    assert.equal(sessions[0].title, '有标题')
    assert.equal(sessions[0].projectRoot, 'D:\\work\\proj\\packages\\app')
    assert.equal(sessions[0].running, true)
    assert.equal(sessions[1].title, 'other', 'no title hint falls back to the folder name')
    assert.equal(sessions[1].agentAvailable, false)
  })

  it('caps the list, ignores junk rows, and degrades when the service is missing or broken', async () => {
    const rows = Array.from({ length: 5 }, (_value, index) => ({ sessionId: `s-${index}`, cwd: `D:\\w\\p${index}`, updatedAt: index }))
    const capped = await listSessions(hostWith(rows), options, { limit: 2 })
    assert.deepEqual(capped.map((session) => session.id), ['s-0', 's-1'])

    const junk = await listSessions(hostWith([null, 'nope', { sessionId: 42, cwd: null }]), options, {})
    assert.deepEqual(junk, [], 'a row without a usable id is dropped')

    assert.equal(await listSessions({ get: () => undefined }, options, {}), undefined)
    assert.equal(await listSessions(hostWith([], { throws: true }), options, {}), undefined)
    assert.equal(await listSessions({ get: (key) => (key === 'sessionController' ? {} : undefined) }, options, {}), undefined)
  })

  it('creates a session through the host service', async () => {
    const asked = []
    const ctx = { get: (key) => (key === 'sessionController' ? { create: async (input) => { asked.push(input); return { sessionId: 's-made' } } } : undefined) }
    assert.deepEqual(await createSession(ctx, { cwd: 'D:\\work' }), { sessionId: 's-made' })
    assert.deepEqual(asked, [{ cwd: 'D:\\work' }])
    assert.equal(await createSession({ get: () => undefined }, { cwd: 'D:\\work' }), undefined)
    // A controller that answers without an identity is not a created session.
    const empty = { get: (key) => (key === 'sessionController' ? { create: async () => ({}) } : undefined) }
    assert.equal(await createSession(empty, { cwd: 'D:\\work' }), undefined)
  })
})

describe('createSession workspace attachment', () => {
  /**
   * A host stand-in with a session controller and a workspace registry.
   * @param {object} [options] - registry shape.
   * @param {Array<{ id?: string, path?: string }>} [options.workspaces] - registry list projection.
   * @param {Function} [options.resolve] - `resolveByPath` stand-in; omitted removes the method.
   * @returns {{ ctx: object, asked: object[] }} the context and the create inputs it received.
   */
  const hostWith = ({ workspaces = [], resolve } = {}) => {
    const asked = []
    const ctx = {
      get: (key) => {
        if (key === 'sessionController') return { create: async (input) => { asked.push(input); return { sessionId: 's-made' } } }
        if (key === 'workspaceRegistry') {
          return {
            list: () => workspaces,
            ...(resolve === undefined ? {} : { resolveByPath: async (path) => resolve(path, workspaces) }),
          }
        }
        return undefined
      },
    }
    return { ctx, asked }
  }

  it('names the workspace that owns the directory instead of a bare cwd', async () => {
    const { ctx, asked } = hostWith({
      workspaces: [{ id: 'w-1', path: 'D:\\work' }],
      resolve: (path, workspaces) => workspaces.find((workspace) => workspace.path === path),
    })
    assert.deepEqual(await createSession(ctx, { cwd: 'D:\\work' }), { sessionId: 's-made' })
    assert.deepEqual(asked, [{ workspaceId: 'w-1' }], 'the host refuses workspaceId and cwd together')
    assert.equal('cwd' in asked[0], false)
  })

  it('keeps the cwd when no workspace owns it, the path does not resolve, or the id is unusable', async () => {
    const unowned = hostWith({ workspaces: [], resolve: () => undefined })
    await createSession(unowned.ctx, { cwd: 'D:\\work' })
    assert.deepEqual(unowned.asked, [{ cwd: 'D:\\work' }])

    // `resolveByPath` rejects for a path that does not exist; that is not a reason
    // to refuse the session, only a reason not to claim a workspace.
    const missing = hostWith({ resolve: () => { throw new Error('ENOENT: no such file or directory') } })
    await createSession(missing.ctx, { cwd: 'D:\\gone' })
    assert.deepEqual(missing.asked, [{ cwd: 'D:\\gone' }])

    const unidentified = hostWith({ workspaces: [{ path: 'D:\\work' }], resolve: (path, workspaces) => workspaces.find((workspace) => workspace.path === path) })
    await createSession(unidentified.ctx, { cwd: 'D:\\work' })
    assert.deepEqual(unidentified.asked, [{ cwd: 'D:\\work' }], 'a record without an id cannot be attached to')
  })

  it('falls back to the list projection on a host without resolveByPath', async () => {
    const listed = hostWith({ workspaces: [{ id: 'w-2', path: 'D:\\work\\' }] })
    await createSession(listed.ctx, { cwd: 'D:\\work' })
    assert.deepEqual(listed.asked, [{ workspaceId: 'w-2' }], 'a trailing separator still names the same directory')

    const other = hostWith({ workspaces: [{ id: 'w-2', path: 'D:\\elsewhere' }] })
    await createSession(other.ctx, { cwd: 'D:\\work' })
    assert.deepEqual(other.asked, [{ cwd: 'D:\\work' }])

    // Windows paths are case-insensitive, so the same directory in another case
    // is still the same workspace; POSIX keeps the exact comparison.
    const cased = hostWith({ workspaces: [{ id: 'w-4', path: 'D:\\WORK' }] })
    await createSession(cased.ctx, { cwd: 'd:\\work' })
    assert.deepEqual(
      cased.asked,
      process.platform === 'win32' ? [{ workspaceId: 'w-4' }] : [{ cwd: 'd:\\work' }],
    )

    // A registry that fails must not block the session: the fallback is a bare cwd.
    const askedOnBroken = []
    const broken = {
      get: (key) => {
        if (key === 'sessionController') return { create: async (input) => { askedOnBroken.push(input); return { sessionId: 's-made' } } }
        if (key === 'workspaceRegistry') return { list: () => { throw new Error('storage offline') } }
        return undefined
      },
    }
    assert.deepEqual(await createSession(broken, { cwd: 'D:\\work' }), { sessionId: 's-made' })
    assert.deepEqual(askedOnBroken, [{ cwd: 'D:\\work' }])
  })
})

describe('deliverToAgent target resolution', () => {
  it('prefers the host session API, which also resumes a cold session', async () => {
    const calls = []
    const ctx = { get: (key) => (key === 'sessionController' ? { prompt: async (request) => { calls.push(request); return { accepted: true } } } : undefined) }
    const outcome = await deliverToAgent(ctx, { sessionId: 's-cold', prompt: 'please finish this todo' })
    assert.equal(outcome.delivered, true)
    assert.equal(outcome.via, 'prompt')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].sessionId, 's-cold')
    assert.equal(calls[0].mode, 'queue')
    assert.match(calls[0].requestId, /^todo-/)
    assert.deepEqual(calls[0].content, [{ type: 'text', text: 'please finish this todo' }])
  })

  it('falls back to a live agent when resuming refuses, and reports when nothing works', async () => {
    const messages = []
    const withAgent = {
      get: (key) => {
        if (key === 'sessionController') return { prompt: async () => { throw new Error('no model configured') } }
        if (key === 'agents') return { get: (id) => (id === 's-live' ? { followup: (message) => messages.push(message) } : undefined) }
        return undefined
      },
    }
    const delivered = await deliverToAgent(withAgent, { sessionId: 's-live', prompt: 'go' })
    assert.equal(delivered.delivered, true)
    assert.equal(delivered.via, 'followup')
    assert.equal(messages[0].role, 'user')

    const alone = {
      get: (key) => (key === 'sessionController' ? { prompt: async () => { throw new Error('no model configured') } } : undefined),
    }
    const failed = await deliverToAgent(alone, { sessionId: 's-cold', prompt: 'go' })
    assert.equal(failed.delivered, false)
    assert.match(failed.reason, /s-cold could not accept the request: no model configured/)
  })
})

describe('client hand-off helpers', () => {
  it('lists the current conversation, a new one, and the other sessions — never a value without an option', async () => {
    const client = await loadClient()
    const sessions = [
      { id: 's-current', title: '当前对话', sameProject: true, agentAvailable: true },
      { id: 's-other', title: '另一个', sameProject: false, running: true, agentAvailable: true },
      { id: 's-gone', title: '旧对话', agentAvailable: false },
    ]
    const options = client.targetOptions({ currentId: 's-current', currentTitle: '当前对话', sessions, canCreate: true })
    assert.deepEqual(options.map((option) => option.value), ['current', 'new', 'session:s-other', 'session:s-gone'])
    assert.equal(options[0].label, '当前会话（当前对话）')
    assert.equal(options[0].disabled, false)
    assert.equal(options[2].label, '另一个 · 运行中')
    assert.equal(options[3].label, '旧对话 · 需恢复')

    // Without a session of its own the current choice is disabled, and without a
    // create capability there is no "new session" option at all.
    const bare = client.targetOptions({ currentId: null, sessions: [], canCreate: false })
    assert.deepEqual(bare.map((option) => option.value), ['current'])
    assert.equal(bare[0].disabled, true)
    assert.equal(bare[0].label, '当前会话')

    // Every value the picker can hold maps to exactly one request shape.
    assert.deepEqual(client.parseTarget('current'), { target: 'current' })
    assert.deepEqual(client.parseTarget('new'), { target: 'new' })
    assert.deepEqual(client.parseTarget('session:s-9'), { target: 'session', sessionId: 's-9' })
    assert.deepEqual(client.parseTarget('nonsense'), { target: 'current' })
  })

  it('offers every project a global todo could run in, and picks the new session\'s cwd', async () => {
    const client = await loadClient()
    const choices = client.projectChoices({
      projects: [{ path: 'D:\\work\\a', title: 'a' }],
      currentRoot: 'D:\\work\\b',
      sessions: [{ projectRoot: 'D:\\work\\c' }, { projectRoot: 'D:\\work\\a' }, { projectRoot: null }],
    })
    assert.deepEqual(choices.map((choice) => choice.path), ['D:\\work\\a', 'D:\\work\\b', 'D:\\work\\c'])
    assert.equal(choices[1].title, 'b（当前项目）')
    assert.deepEqual(client.projectChoices({}), [])

    // A project todo always runs in its own project, whatever the picker says.
    assert.equal(client.newSessionCwd({ scope: 'project' }, { cwd: 'D:\\wrong' }, { projectRoot: 'D:\\own' }), 'D:\\own')
    assert.equal(client.newSessionCwd({ scope: 'project' }, { cwd: 'D:\\wrong' }, null), 'D:\\wrong')
    // A global todo runs where the user pointed it.
    assert.equal(client.newSessionCwd({ scope: 'global' }, { cwd: '  D:\\picked  ' }, { projectRoot: 'D:\\ignored' }), 'D:\\picked')
    assert.equal(client.newSessionCwd({ scope: 'global' }, {}, null), '')
    assert.equal(client.folderName('D:\\work\\proj\\'), 'proj')
  })
})

/** The bundle registers once per process, so capture its registration the first time. */
let clientRegistration = null

/**
 * Load the browser bundle against stub page globals and hand back its exports.
 * @returns {Promise<object>} the client module.
 */
async function loadClient() {
  if (clientRegistration === null) clientRegistration = await materializeClient()
  return clientRegistration.factory((specifier) => {
    if (specifier === 'react') return stubReact()
    throw new Error(`unexpected require(${specifier})`)
  })
}

/**
 * Import the bundle once, while the page stubs are installed, and capture the
 * module registration it publishes (the factory inserts its stylesheet
 * synchronously, so it must be materialized exactly like the module system does).
 * @returns {Promise<object>} the registration.
 */
async function materializeClient() {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  let registration
  globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value } } }
  globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: () => {} } }
  try {
    await import(new URL('../lib/client.js', import.meta.url).href)
    registration.factory((specifier) => {
      if (specifier === 'react') return stubReact()
      throw new Error(`unexpected require(${specifier})`)
    })
    return registration
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
}

/** The React subset the bundle's pure helpers and render need. */
function stubReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useCallback: (callback) => callback,
    useEffect: () => {},
  }
}
