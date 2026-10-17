/**
 * Panel API tests for `dsh-plugin-todo` (`lib/api.js`).
 *
 * The API is framework-free — `handle(request)` returns `{ status, body }` — so
 * these tests drive it directly, over real `TodoStore` instances in a temporary
 * directory. They cover the browser-session gate, the `x-todo-client` marker,
 * the project-resolution precedence, the `/state` shape, and the one rule that
 * makes the panel the plugin: every mutation runs as the `user` actor, whatever
 * the request body claims.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { API_PREFIX, CLIENT_HEADER, createTodoApi } from '../lib/api.js'
import { STATUSES, TodoStore } from '../lib/store.js'

/** @type {string} */
let root
/** @type {string} */
let project

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'todo-api-'))
  project = join(root, 'proj')
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * Build an API over real stores, plus a raw dispatcher that always sends the
 * marker header (tests that probe the guard pass their own `headers`).
 * @param {string} name - subdirectory that isolates this test's todos.
 * @param {object} [options] - deployment overrides.
 */
function makeApi(name, { level = 'both', defaultScope = 'project', projects = [], sessions = {}, deliverRequest } = {}) {
  const stores = new Map()
  const storeFor = (cwd) => {
    let store = stores.get(cwd)
    if (store === undefined) {
      store = new TodoStore({
        cwd,
        level,
        defaultScope,
        dshHome: root,
        globalDir: join(cwd, '.global'),
        projectRootMarkers: [],
      })
      stores.set(cwd, store)
    }
    return store
  }
  const api = createTodoApi({
    storeFor,
    listProjects: () => projects,
    resolveSessionCwd: (sessionId) => sessions[sessionId],
    deliverRequest,
  })
  const cwd = join(project, name)
  /**
   * Seed todos straight through the store — the model's own tools are what add
   * a proposal, and the panel must never be able to do it for the model.
   * @returns {Promise<Array<Record<string, unknown>>>} the created todos.
   */
  const seed = async (items, { origin = 'ai', scope = 'project' } = {}) => (await storeFor(cwd).create({ items, origin, scope })).todos
  /**
   * Walk one todo to a status the panel cannot reach on its own (for example
   * `review`, which only the model may submit into).
   */
  const reach = async (id, status) => {
    const store = storeFor(cwd)
    if (status === 'proposed' || status === 'open') return
    await store.act({ id, action: 'claim', actor: 'ai' })
    if (status === 'working') return
    if (status === 'blocked') {
      await store.act({ id, action: 'ask', actor: 'ai', question: 'which one?' })
      return
    }
    await store.act({ id, action: 'submit', actor: 'ai', summary: 'finished' })
    if (status === 'review') return
    await store.act({ id, action: 'confirm', actor: 'user' })
    if (status === 'confirmed') return
    await store.act({ id, action: 'complete', actor: 'ai' })
    if (status !== 'done') throw new Error(`cannot reach ${status}`)
  }
  return {
    cwd,
    stores,
    storeFor,
    seed,
    reach,
    send: (method, route, { body, query, headers } = {}) => api.handle({
      method,
      pathname: `${API_PREFIX}${route}`,
      query,
      headers: { [CLIENT_HEADER]: '1', ...headers },
      body,
    }),
    raw: (request) => api.handle(request),
  }
}

describe('todo api guard', () => {
  it('applies the host browser-session gate before anything else', async () => {
    const storeFor = (cwd) => new TodoStore({ cwd, globalDir: join(cwd, '.global'), projectRootMarkers: [] })
    const denied = createTodoApi({ storeFor, admit: () => 401 })
    const response = await denied.handle({ method: 'GET', pathname: `${API_PREFIX}/state`, headers: { [CLIENT_HEADER]: '1' } })
    assert.equal(response.status, 401)
    assert.match(response.body.error, /unauthenticated/)

    const fenced = createTodoApi({ storeFor, admit: () => 403 })
    const fencedResponse = await fenced.handle({ method: 'GET', pathname: `${API_PREFIX}/state`, headers: {} })
    assert.equal(fencedResponse.status, 403)
    assert.match(fencedResponse.body.error, /origin fence/)

    // The gate sees exactly the headers the Web handler received.
    const seen = []
    const gated = createTodoApi({
      storeFor,
      admit: (request) => {
        seen.push(request.headers)
        return undefined
      },
    })
    await gated.handle({ method: 'GET', pathname: `${API_PREFIX}/state`, headers: { host: '127.0.0.1:19387', cookie: 'a=b' } })
    assert.deepEqual(seen, [{ host: '127.0.0.1:19387', cookie: 'a=b' }])

    // Without `admit` there is no gate at all: only the marker is required.
    const open = createTodoApi({ storeFor })
    assert.equal((await open.handle({ method: 'GET', pathname: `${API_PREFIX}/state`, headers: { [CLIENT_HEADER]: '1' } })).status, 200)
  })

  it('requires the client marker header', async () => {
    const api = makeApi('guard')
    const denied = await api.raw({ method: 'GET', pathname: `${API_PREFIX}/state`, headers: {} })
    assert.equal(denied.status, 403)
    assert.match(denied.body.error, /x-todo-client/)
    const wrong = await api.raw({ method: 'GET', pathname: `${API_PREFIX}/state`, headers: { [CLIENT_HEADER]: 'true' } })
    assert.equal(wrong.status, 403)
    assert.equal((await api.send('GET', '/state', { query: { project: api.cwd } })).status, 200)
  })

  it('answers 404 for an unknown route and 405 for a wrong method', async () => {
    const api = makeApi('routing')
    const unknown = await api.send('GET', '/nope', { query: { project: api.cwd } })
    assert.equal(unknown.status, 404)
    assert.match(unknown.body.error, /unknown todo route/)
    assert.equal((await api.send('PATCH', '/state', { query: { project: api.cwd } })).status, 405)
    assert.equal((await api.send('GET', '/todos', { query: { project: api.cwd } })).status, 405)
    assert.equal((await api.send('GET', '/action', { query: { project: api.cwd } })).status, 405)
    assert.equal((await api.send('PUT', '/request', { body: { project: api.cwd } })).status, 405)
    assert.equal((await api.send('POST', '/todo', { body: { project: api.cwd } })).status, 405)
    assert.equal((await api.send('POST', '/prompt', { body: { project: api.cwd } })).status, 405)
  })
})

describe('todo api /state', () => {
  it('describes both levels, the project root, the projects, and the statuses', async () => {
    const api = makeApi('state', { projects: [{ path: project, title: 'proj' }] })
    const response = await api.send('GET', '/state', { query: { project: api.cwd, limit: '0' } })
    assert.equal(response.status, 200)
    assert.equal(response.body.level, 'both')
    assert.equal(response.body.defaultScope, 'project')
    assert.equal(response.body.cwd, api.cwd)
    assert.equal(response.body.projectRoot, api.cwd)
    assert.deepEqual(response.body.current, { source: 'manual', path: api.cwd, projectRoot: api.cwd })
    assert.deepEqual(response.body.projects, [{ path: project, title: 'proj' }])
    assert.deepEqual(response.body.statuses, STATUSES)
    assert.equal(response.body.canDeliver, false)

    assert.equal(response.body.levels.global.scope, 'global')
    assert.equal(response.body.levels.global.enabled, true)
    assert.equal(response.body.levels.global.dir, join(api.cwd, '.global'))
    assert.equal(response.body.levels.global.file, join(api.cwd, '.global', 'todos.jsonl'))
    assert.equal(response.body.levels.global.total, 0)
    assert.deepEqual(Array.from({ length: 8 }, (_value, index) => response.body.levels.global.todos[index]).filter(Boolean), [])
    assert.equal(response.body.levels.project.scope, 'project')
    assert.equal(response.body.levels.project.enabled, true)
    assert.match(response.body.levels.project.file, /\.dsh[\\/]todo[\\/]todos\.jsonl$/)
    assert.equal(typeof response.body.levels.project.counts.open, 'number')
  })

  it('reports canDeliver when the host can hand a todo to the model', async () => {
    const api = makeApi('state-deliver', { deliverRequest: async () => ({ delivered: true }) })
    const response = await api.send('GET', '/state', { query: { project: api.cwd } })
    assert.equal(response.body.canDeliver, true)
  })

  it('marks a disabled level instead of hiding it', async () => {
    const api = makeApi('state-global-only', { level: 'global', defaultScope: 'global' })
    const response = await api.send('GET', '/state', { query: { project: api.cwd } })
    assert.equal(response.status, 200)
    assert.equal(response.body.levels.global.enabled, true)
    assert.deepEqual(response.body.levels.project, { scope: 'project', enabled: false, todos: [], total: 0, counts: {} })
  })

  it('returns summaries, never the full detail, and keeps the counts before the status filter', async () => {
    const api = makeApi('state-rows')
    await api.send('POST', '/todos', {
      body: { project: api.cwd, scope: 'project', title: 'visible row', detail: 'a long explanation', tags: ['ui'] },
    })
    await api.seed([{ title: 'proposal', detail: 'proposed detail' }])

    const response = await api.send('GET', '/state', { query: { project: api.cwd, limit: '0' } })
    const level = response.body.levels.project
    assert.equal(level.total, 2)
    assert.equal(level.todos.length, 2)
    for (const row of level.todos) {
      assert.equal('detail' in row, false)
      assert.equal('history' in row, false)
      assert.deepEqual(row.actions, row.status === 'proposed'
        ? ['accept', 'complete', 'update', 'void']
        : ['request', 'complete', 'update', 'void'])
    }
    assert.equal(level.counts.proposed, 1)
    assert.equal(level.counts.open, 1)

    // The status filter narrows the rows and the total, not the counts.
    const proposed = await api.send('GET', '/state', { query: { project: api.cwd, status: 'proposed', limit: '0' } })
    assert.equal(proposed.body.levels.project.total, 1)
    assert.equal(proposed.body.levels.project.todos[0].title, 'proposal')
    assert.equal(proposed.body.levels.project.counts.open, 1)
    assert.equal(proposed.body.levels.project.counts.proposed, 1)
  })

  it('honors the limit query parameter and rejects a bad one', async () => {
    const api = makeApi('state-limit')
    await api.seed([{ title: 'one' }, { title: 'two' }, { title: 'three' }], { origin: 'user' })
    const limited = await api.send('GET', '/state', { query: { project: api.cwd, limit: '1' } })
    assert.equal(limited.body.levels.project.total, 3)
    assert.equal(limited.body.levels.project.todos.length, 1)
    assert.equal((await api.send('GET', '/state', { query: { project: api.cwd, limit: '0' } })).body.levels.project.todos.length, 3)
    const bad = await api.send('GET', '/state', { query: { project: api.cwd, limit: '-1' } })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /limit must be a non-negative integer/)
    const badStatus = await api.send('GET', '/state', { query: { project: api.cwd, status: 'archived' } })
    assert.equal(badStatus.status, 400)
    assert.match(badStatus.body.error, /unknown status/)
  })

  it('resolves the project: explicit, then the live session, then the newest registered one, then process.cwd()', async () => {
    const recent = join(project, 'newest')
    const live = join(project, 'live')
    const api = makeApi('selector', {
      projects: [{ path: recent, title: 'newest' }, { path: live, title: 'live' }],
      sessions: { 'session-live': live },
    })

    const manual = await api.send('GET', '/state', { query: { session: 'session-live', project: recent } })
    assert.equal(manual.body.current.source, 'manual')
    assert.equal(manual.body.current.path, recent)
    assert.equal(manual.body.cwd, recent)
    assert.equal(manual.body.projectRoot, recent)

    const followed = await api.send('GET', '/state', { query: { session: 'session-live' } })
    assert.equal(followed.body.current.source, 'session')
    assert.equal(followed.body.current.path, live)
    assert.equal(followed.body.cwd, live)

    // A session that is gone (closed, or from an earlier app run) falls back to
    // the most recently updated registered workspace instead of failing.
    const unknown = await api.send('GET', '/state', { query: { session: 'session-gone' } })
    assert.equal(unknown.body.current.source, 'default')
    assert.equal(unknown.body.current.path, recent)

    // With nothing registered either, the host process directory is the target.
    const bare = makeApi('selector-bare')
    const fallback = await bare.send('GET', '/state', {})
    assert.equal(fallback.body.current.source, 'default')
    assert.equal(fallback.body.current.path, process.cwd())
  })
})

describe('todo api /todo', () => {
  it('returns the full record with the actions and the attention flag', async () => {
    const api = makeApi('record')
    const [proposal] = await api.seed([{ title: 'full record', detail: 'context', acceptance: 'green tests', tags: ['x'] }])
    const response = await api.send('GET', '/todo', { query: { project: api.cwd, id: proposal.id } })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    const todo = response.body.todo
    assert.equal(todo.id, proposal.id)
    assert.equal(todo.title, 'full record')
    assert.equal(todo.detail, 'context')
    assert.equal(todo.acceptance, 'green tests')
    assert.equal(todo.status, 'proposed')
    assert.equal(todo.attention, true)
    assert.deepEqual(todo.actions, ['accept', 'complete', 'update', 'void'])
    assert.equal(todo.file, join(api.cwd, '.dsh', 'todo', 'todos.jsonl'))
    assert.deepEqual(todo.tags, ['x'])
    assert.equal(Array.isArray(todo.history), true)
  })

  it('answers 404 for an unknown id and 400 without one', async () => {
    const api = makeApi('record-missing')
    const missing = await api.send('GET', '/todo', { query: { project: api.cwd, id: 'p-nope' } })
    assert.equal(missing.status, 404)
    assert.match(missing.body.error, /no todo "p-nope"/)
    const blank = await api.send('GET', '/todo', { query: { project: api.cwd } })
    assert.equal(blank.status, 400)
    assert.match(blank.body.error, /id must be a non-blank string/)
  })
})

describe('todo api /prompt', () => {
  it('renders the request prompt with the todo and the workflow steps', async () => {
    const api = makeApi('prompt')
    const [todo] = await api.seed([{ title: 'prompt target', detail: 'the details', acceptance: 'the criteria' }])
    const response = await api.send('GET', '/prompt', { query: { project: api.cwd, id: todo.id } })
    assert.equal(response.status, 200)
    assert.equal(response.body.id, todo.id)
    const prompt = response.body.prompt
    assert.ok(prompt.includes(todo.id), 'carries the id')
    assert.ok(prompt.includes('prompt target'), 'carries the title')
    assert.ok(prompt.includes('the details'), 'carries the detail')
    assert.ok(prompt.includes('the criteria'), 'carries the acceptance criteria')
    assert.match(prompt, /执行流程/)
    assert.ok(prompt.includes('todo_get'))
    assert.ok(prompt.includes('todo_submit'))
    assert.ok(prompt.includes('todo_complete'))
    assert.match(prompt, /用户确认之前不能把待办标记成已完成/)
  })

  it('requires the id and answers 404 for an unknown one', async () => {
    const api = makeApi('prompt-missing')
    const blank = await api.send('GET', '/prompt', { query: { project: api.cwd } })
    assert.equal(blank.status, 400)
    assert.match(blank.body.error, /id must be a non-blank string/)
    assert.equal((await api.send('GET', '/prompt', { query: { project: api.cwd, id: 'p-nope' } })).status, 404)
  })
})

describe('todo api /todos', () => {
  it('creates as the user, so the new todo is open and accepted', async () => {
    const api = makeApi('create')
    const response = await api.send('POST', '/todos', {
      body: {
        project: api.cwd,
        scope: 'project',
        title: 'from the panel',
        detail: 'context',
        acceptance: 'green',
        priority: 'high',
        tags: [' ui ', 'ui'],
      },
    })
    assert.equal(response.status, 201)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.todo.title, 'from the panel')
    assert.equal(response.body.todo.status, 'open')
    assert.equal(response.body.todo.origin, 'user')
    assert.deepEqual(response.body.todo.tags, ['ui'])
    assert.equal(response.body.todo.priority, 'high')

    // The level payload merges straight back into the /state shape.
    assert.equal(response.body.scope, 'project')
    assert.equal(response.body.enabled, true)
    assert.equal(response.body.total, 1)
    assert.equal(typeof response.body.counts.open, 'number')
    assert.equal(response.body.todos.length, 1)

    const stored = await api.storeFor(api.cwd).get({ id: response.body.todo.id })
    assert.equal(stored.accepted.by, 'user')
  })

  it('adds to the global level when asked', async () => {
    const api = makeApi('create-global')
    const response = await api.send('POST', '/todos', { body: { project: api.cwd, scope: 'global', title: 'everywhere' } })
    assert.equal(response.status, 201)
    assert.equal(response.body.scope, 'global')
    assert.equal(response.body.todo.scope, 'global')
    assert.match(response.body.todo.id, /^g-/)
    assert.equal(response.body.file, join(api.cwd, '.global', 'todos.jsonl'))
  })

  it('rejects a blank title, a non-string title, and non-array tags', async () => {
    const api = makeApi('create-invalid')
    const blank = await api.send('POST', '/todos', { body: { project: api.cwd, title: '   ' } })
    assert.equal(blank.status, 400)
    assert.match(blank.body.error, /title must be a non-blank string/)
    const missing = await api.send('POST', '/todos', { body: { project: api.cwd } })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error, /title must be a non-blank string/)
    const numeric = await api.send('POST', '/todos', { body: { project: api.cwd, title: 42 } })
    assert.equal(numeric.status, 400)
    assert.match(numeric.body.error, /title must be a string/)
    const badTags = await api.send('POST', '/todos', { body: { project: api.cwd, title: 'ok', tags: 'ui' } })
    assert.equal(badTags.status, 400)
    assert.match(badTags.body.error, /tags must be an array of strings/)
    assert.equal((await api.send('POST', '/todos', { body: { project: api.cwd, title: 'ok' } })).status, 201)
  })

  it('routes each project to its own file', async () => {
    const api = makeApi('create-projects')
    const other = join(project, 'create-projects-other')
    await api.send('POST', '/todos', { body: { project: api.cwd, title: 'in one' } })
    await api.send('POST', '/todos', { body: { project: other, title: 'in the other' } })
    const first = await api.send('GET', '/state', { query: { project: api.cwd, limit: '0' } })
    const second = await api.send('GET', '/state', { query: { project: other, limit: '0' } })
    assert.equal(first.body.levels.project.todos[0].title, 'in one')
    assert.equal(second.body.levels.project.todos[0].title, 'in the other')
    assert.equal(api.stores.size, 2)
  })
})

describe('todo api /action', () => {
  it('accepts a proposal as the user, so it becomes a real todo', async () => {
    const api = makeApi('action-accept')
    const [proposal] = await api.seed([{ title: 'model idea' }])
    const response = await api.send('POST', '/action', { body: { project: api.cwd, id: proposal.id, action: 'accept' } })
    assert.equal(response.status, 200)
    assert.equal(response.body.todo.status, 'open')
    assert.equal(response.body.scope, 'project')
    assert.deepEqual(response.body.counts, Object.fromEntries(STATUSES.map((status) => [status, status === 'open' ? 1 : 0])))
    assert.equal((await api.storeFor(api.cwd).get({ id: proposal.id })).accepted.by, 'user')
  })

  it('always acts as the user, ignoring an `actor` the body tries to set', async () => {
    const api = makeApi('action-actor')
    const [proposal] = await api.seed([{ title: 'ai self-accept attempt' }])
    // Were the body's actor honoured, this very call would be refused.
    const accepted = await api.send('POST', '/action', {
      body: { project: api.cwd, id: proposal.id, action: 'accept', actor: 'ai' },
    })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.todo.status, 'open')

    // `complete` only works for the user from `review`; the body cannot claim
    // to be the model to skip that rule.
    const [job] = await api.seed([{ title: 'job' }], { origin: 'user' })
    await api.reach(job.id, 'review')
    const completed = await api.send('POST', '/action', {
      body: { project: api.cwd, id: job.id, action: 'complete', actor: 'ai' },
    })
    assert.equal(completed.status, 200)
    assert.equal(completed.body.todo.status, 'done')
    const stored = await api.storeFor(api.cwd).get({ id: job.id })
    assert.equal(stored.approval.by, 'user')
    assert.equal(stored.completion.by, 'user')
  })

  it('confirms a submitted result as the user', async () => {
    const api = makeApi('action-confirm')
    const [job] = await api.seed([{ title: 'submitted' }], { origin: 'user' })
    await api.reach(job.id, 'review')
    const response = await api.send('POST', '/action', { body: { project: api.cwd, id: job.id, action: 'confirm' } })
    assert.equal(response.status, 200)
    assert.equal(response.body.todo.status, 'confirmed')
    assert.equal((await api.storeFor(api.cwd).get({ id: job.id })).approval.by, 'user')
  })

  it('records an answer and returns the todo to working', async () => {
    const api = makeApi('action-answer')
    const [job] = await api.seed([{ title: 'needs info' }], { origin: 'user' })
    await api.reach(job.id, 'blocked')
    const response = await api.send('POST', '/action', {
      body: { project: api.cwd, id: job.id, action: 'answer', text: 'here is the answer' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.todo.status, 'working')
    assert.equal(response.body.todo.question, null)
    assert.equal(response.body.todo.answerCount, 1)
    const stored = await api.storeFor(api.cwd).get({ id: job.id })
    assert.deepEqual(stored.answers.map((answer) => answer.text), ['here is the answer'])
    assert.equal(stored.detail, 'here is the answer')
  })

  it('voids a todo as the user without needing a reason, and with the one supplied', async () => {
    const api = makeApi('action-void')
    const [plain] = await api.seed([{ title: 'no reason needed' }], { origin: 'user' })
    const bare = await api.send('POST', '/action', { body: { project: api.cwd, id: plain.id, action: 'void' } })
    assert.equal(bare.status, 200)
    assert.equal(bare.body.todo.status, 'void')
    assert.equal(typeof bare.body.todo.voided.reason, 'string')

    const [explained] = await api.seed([{ title: 'with a reason' }], { origin: 'user' })
    const withReason = await api.send('POST', '/action', {
      body: { project: api.cwd, id: explained.id, action: 'void', reason: 'requirements changed' },
    })
    assert.equal(withReason.status, 200)
    assert.equal(withReason.body.todo.voided.reason, 'requirements changed')
  })

  it('updates the editable fields and forwards tags as an array', async () => {
    const api = makeApi('action-update')
    const [todo] = await api.seed([{ title: 'before' }], { origin: 'user' })
    const response = await api.send('POST', '/action', {
      body: {
        project: api.cwd,
        id: todo.id,
        action: 'update',
        title: 'after',
        detail: 'new detail',
        acceptance: 'new acceptance',
        priority: 'low',
        tags: ['a', 'b'],
        note: 'from the panel',
      },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.todo.title, 'after')
    assert.equal(response.body.todo.preview, 'new detail')
    assert.equal(response.body.todo.acceptance, 'new acceptance')
    assert.equal(response.body.todo.priority, 'low')
    assert.deepEqual(response.body.todo.tags, ['a', 'b'])
    const badTags = await api.send('POST', '/action', { body: { project: api.cwd, id: todo.id, action: 'update', tags: 'a' } })
    assert.equal(badTags.status, 400)
    assert.match(badTags.body.error, /tags must be an array of strings/)
  })

  it('rejects an unknown action, an unknown id, a bad body, and a store refusal', async () => {
    const api = makeApi('action-errors')
    const [todo] = await api.seed([{ title: 'plain' }], { origin: 'user' })
    const unknown = await api.send('POST', '/action', { body: { project: api.cwd, id: todo.id, action: 'explode' } })
    assert.equal(unknown.status, 400)
    assert.match(unknown.body.error, /unknown action "explode"/)
    const missing = await api.send('POST', '/action', { body: { project: api.cwd, id: 'p-nope', action: 'claim' } })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error, /no todo "p-nope"/)
    const blankId = await api.send('POST', '/action', { body: { project: api.cwd, action: 'claim' } })
    assert.equal(blankId.status, 400)
    assert.match(blankId.body.error, /id must be a non-blank string/)
    const blankAction = await api.send('POST', '/action', { body: { project: api.cwd, id: todo.id } })
    assert.equal(blankAction.status, 400)
    assert.match(blankAction.body.error, /action must be a non-blank string/)

    for (const body of ['not-an-object', ['an', 'array'], 42]) {
      const bad = await api.send('POST', '/action', { body })
      assert.equal(bad.status, 400)
      assert.match(bad.body.error, /request body must be a JSON object/)
    }

    // A TodoError from the store surfaces as 400 with its own message.
    const refused = await api.send('POST', '/action', { body: { project: api.cwd, id: todo.id, action: 'accept' } })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error, /accept is not allowed on a open todo/)
  })

  it('refuses a disabled scope with the store message', async () => {
    const api = makeApi('action-disabled', { level: 'global', defaultScope: 'global' })
    const [todo] = await api.seed([{ title: 'global only' }], { origin: 'user', scope: 'global' })
    const response = await api.send('POST', '/action', {
      body: { project: api.cwd, id: todo.id, action: 'claim', scope: 'project' },
    })
    assert.equal(response.status, 400)
    assert.match(response.body.error, /disabled/)
  })
})

describe('todo api /request', () => {
  it('answers 409 with the prepared prompt when the host cannot deliver', async () => {
    const api = makeApi('request-no-deliver')
    const [todo] = await api.seed([{ title: 'hand this over', detail: 'the detail' }], { origin: 'user' })
    const response = await api.send('POST', '/request', { body: { project: api.cwd, id: todo.id, session: 'session-1' } })
    assert.equal(response.status, 409)
    assert.match(response.body.error, /does not deliver requests to the model/)
    assert.ok(response.body.prompt.includes(todo.id))
    assert.ok(response.body.prompt.includes('the detail'))
  })

  it('answers 409 with the delivery reason when the model refuses it', async () => {
    const api = makeApi('request-refused', {
      deliverRequest: async () => ({ delivered: false, reason: 'session session-9 has no live agent' }),
    })
    const [todo] = await api.seed([{ title: 'refused' }], { origin: 'user' })
    const response = await api.send('POST', '/request', { body: { project: api.cwd, id: todo.id, session: 'session-9' } })
    assert.equal(response.status, 409)
    assert.equal(response.body.error, 'session session-9 has no live agent')
    assert.equal(typeof response.body.prompt, 'string')
    assert.equal((await api.storeFor(api.cwd).get({ id: todo.id })).status, 'open')
  })

  it('needs a live session, even when delivery itself works', async () => {
    const api = makeApi('request-no-session', { deliverRequest: async () => ({ delivered: true }) })
    const [todo] = await api.seed([{ title: 'no session given' }], { origin: 'user' })
    const response = await api.send('POST', '/request', { body: { project: api.cwd, id: todo.id } })
    assert.equal(response.status, 409)
    assert.match(response.body.error, /no live session/)
    assert.equal(typeof response.body.prompt, 'string')
  })

  it('delivers a user-role request and claims the todo for the model', async () => {
    const delivered = []
    const api = makeApi('request-delivered', {
      deliverRequest: async (input) => {
        delivered.push(input)
        return { delivered: true }
      },
    })
    const [todo] = await api.seed([{ title: 'please do this', detail: 'details here' }], { origin: 'user' })
    const response = await api.send('POST', '/request', {
      body: { project: api.cwd, id: todo.id, session: 'session-42' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.delivered, true)
    assert.equal(response.body.claimed, true)
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].sessionId, 'session-42')
    assert.equal(delivered[0].todo.id, todo.id)
    assert.ok(delivered[0].prompt.includes('please do this'))

    // The panel's own claim moved the todo into the model's hands. `/request`
    // answers with the refreshed level rather than a single `todo`, so the row
    // is read back from the listing it returns.
    assert.equal(response.body.todos[0].status, 'working')
    assert.equal((await api.storeFor(api.cwd).get({ id: todo.id })).status, 'working')
    // ...and the merged level payload carries the refreshed row.
    assert.equal(response.body.scope, 'project')
    assert.equal(response.body.todos.length, 1)
    assert.equal(response.body.counts.working, 1)
  })

  it('accepts the session from the query string, and 404s an unknown todo', async () => {
    const delivered = []
    const api = makeApi('request-query-session', {
      deliverRequest: async (input) => {
        delivered.push(input)
        return { delivered: true }
      },
    })
    const [todo] = await api.seed([{ title: 'query session' }], { origin: 'user' })
    const response = await api.send('POST', '/request', { body: { project: api.cwd, id: todo.id }, query: { session: 'session-7' } })
    assert.equal(response.status, 200)
    assert.equal(delivered[0].sessionId, 'session-7')

    const missing = await api.send('POST', '/request', { body: { project: api.cwd, id: 'p-nope', session: 'session-7' } })
    assert.equal(missing.status, 404)
  })
})

describe('todo api level payloads', () => {
  it('merges a mutated level back into the state shape on every mutation route', async () => {
    const api = makeApi('merge', { deliverRequest: async () => ({ delivered: true }) })
    const created = await api.send('POST', '/todos', { body: { project: api.cwd, scope: 'project', title: 'first' } })
    const [proposal] = await api.seed([{ title: 'second' }])
    const acted = await api.send('POST', '/action', { body: { project: api.cwd, id: proposal.id, action: 'accept' } })
    const requested = await api.send('POST', '/request', {
      body: { project: api.cwd, id: created.body.todo.id, session: 'session-1' },
    })

    for (const [label, body] of [['create', created.body], ['action', acted.body], ['request', requested.body]]) {
      assert.equal(body.scope, 'project', `${label} reports its scope`)
      assert.equal(body.enabled, true, `${label} reports the level enabled`)
      assert.equal(Array.isArray(body.todos), true, `${label} carries rows`)
      assert.equal(typeof body.counts, 'object', `${label} carries counts`)
      assert.equal(typeof body.total, 'number', `${label} carries the total`)
      assert.equal(typeof body.file, 'string', `${label} carries the file`)
      assert.equal(typeof body.dir, 'string', `${label} carries the directory`)
    }
    assert.equal(created.body.scope, 'project')
    assert.equal(requested.body.scope, 'project')
  })
})
