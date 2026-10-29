#!/usr/bin/env node
/**
 * Real-runtime smoke test for the todo plugin.
 *
 * It mounts the plugin on an actual Cordis `Context` together with the actual
 * `@deepseek-ai/dsh-tools` registry, then drives the whole confirmation
 * workflow through the real `ctx.tools.execute` pipeline and the real panel API:
 *
 *   model proposes → user accepts → model claims → model asks → user answers →
 *   model submits → user confirms in the panel (which completes the todo)
 *
 * plus the two rules the plugin exists for: the model can neither accept its own
 * proposal nor mark anything done — there is no model completion path at all,
 * so the user's confirmation is the only way into `done`.
 *
 * Run from this repository (the bundled runtime works too):
 *   node scripts/smoke-runtime.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as todo from '../todo/lib/index.js'
import { API_PREFIX, CLIENT_HEADER, createTodoApi } from '../todo/lib/api.js'

const root = await mkdtemp(join(tmpdir(), 'todo-smoke-'))
const cwd = join(root, 'project')
const globalDir = join(root, 'global')
/** Minimal Agent stand-in: the todo plugin reads `agent.session.header.cwd`. */
const agent = { session: { header: { cwd } } }
let sequence = 0

/** Dispatch one call through the real registry and fail loudly on error results. */
async function call(ctx, name, args, { expectError = false } = {}) {
  const result = await ctx.tools.execute({
    callId: `smoke-${++sequence}`,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
  if (expectError) {
    assert.equal(result.isError, true, `${name} was expected to fail`)
    return result
  }
  assert.equal(result.isError, false, `${name} failed: ${JSON.stringify(result.content)}`)
  return result
}

/** Drive one panel API request the way the browser half does. */
async function panel(api, method, path, body) {
  const [pathname, search = ''] = path.split('?')
  return api.handle({
    method,
    pathname: `${API_PREFIX}${pathname}`,
    query: Object.fromEntries(new URLSearchParams(search).entries()),
    headers: { [CLIENT_HEADER]: '1' },
    body,
  })
}

try {
  await mkdir(cwd, { recursive: true })
  const ctx = new Context()
  // The real tool registry declares `inject: ['systemPrompt']`, so mount the real
  // prompt service first; the todo plugin itself is then mounted by name.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(todo, { globalDir, defaultScope: 'project', projectRootMarkers: [] })

  const expected = [
    'todo_claim', 'todo_get', 'todo_list', 'todo_propose',
    'todo_submit', 'todo_update', 'todo_void',
  ]
  const schemas = ctx.tools.schemas().map((schema) => schema.name).sort()
  assert.deepEqual(schemas, expected)
  console.log(`✓ registered on the live registry: ${schemas.join(', ')}`)

  // The panel API over the same store the tools use.
  const stores = new Map()
  const api = createTodoApi({
    storeFor: (directory) => {
      if (!stores.has(directory)) stores.set(directory, new todo.TodoStore({ cwd: directory, globalDir, projectRootMarkers: [] }))
      return stores.get(directory)
    },
  })
  const withProject = (body) => ({ ...body, project: cwd })

  // --- 1. the model proposes; nothing is a real todo yet -------------------
  const proposed = await call(ctx, 'todo_propose', {
    todos: [
      { title: '给 README 补一节安装说明', detail: '写清楚 profile 级和 home 级两种安装', acceptance: 'README 里有可直接复制的命令', priority: 'high', tags: ['docs'] },
      { title: '核对发布清单' },
    ],
  })
  assert.equal(proposed.value.created.length, 2)
  assert.deepEqual(proposed.value.created.map((item) => item.status), ['proposed', 'proposed'])
  const [first, second] = proposed.value.created.map((item) => item.id)
  assert.equal(proposed.value.total, 2)
  assert.match(proposed.content[0].text, /waiting for the user to accept/)
  console.log('✓ todo_propose created 2 todos in `proposed`')

  // --- 2. the model cannot confirm its own proposal ------------------------
  const selfAccept = await call(ctx, 'todo_claim', { id: first }, { expectError: true })
  assert.match(selfAccept.error.message, /not allowed on a proposed todo/)
  console.log('✓ the model cannot start an unaccepted proposal')

  // --- 3. the user accepts one, rejects the other, in the panel ------------
  const accepted = await panel(api, 'POST', '/action', withProject({ id: first, action: 'accept' }))
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.todo.status, 'open')
  const rejected = await panel(api, 'POST', '/action', withProject({ id: second, action: 'reject', reason: '这一条不做了' }))
  assert.equal(rejected.body.todo.status, 'void')
  assert.equal(rejected.body.counts.void, 1)
  console.log('✓ the user accepted one proposal and voided the other')

  // --- 4. insufficient information: the model asks, the user answers -------
  const claimed = await call(ctx, 'todo_claim', { id: first })
  assert.equal(claimed.value.status, 'working')
  assert.match(claimed.content[0].text, /enough information/)
  const asked = await call(ctx, 'todo_update', { id: first, question: '安装说明要写到哪一层？' })
  assert.equal(asked.value.status, 'blocked')
  assert.equal(asked.value.question, '安装说明要写到哪一层？')
  const answered = await panel(api, 'POST', '/action', withProject({ id: first, action: 'answer', text: '两层都写' }))
  assert.equal(answered.body.todo.status, 'working')
  assert.equal(answered.body.todo.answerCount, 1)
  console.log('✓ model asked for missing information, user answered, todo returned to `working`')

  // --- 5. the model submits; it has no completion path ---------------------
  const submitted = await call(ctx, 'todo_submit', { id: first, summary: 'README 补了两级安装说明', evidence: 'README.md +40 行' })
  assert.equal(submitted.value.status, 'review')
  assert.match(submitted.content[0].text, /waiting for the user's confirmation/)
  const inReview = await call(ctx, 'todo_get', { id: first })
  assert.equal(inReview.value.status, 'review')
  assert.deepEqual(inReview.value.availableActions, ['update', 'void'], 'a review todo offers the model no completion')
  assert.equal(inReview.value.availableActions.includes('complete'), false, 'todo_complete is gone: the model cannot complete anything')
  console.log('✓ todo_submit moved it to `review`; the model has no `complete` action at all')

  // --- 6. the panel confirmation IS the completion -------------------------
  const confirmed = await panel(api, 'POST', '/action', withProject({ id: first, action: 'confirm', note: '看过了' }))
  assert.equal(confirmed.status, 200)
  assert.equal(confirmed.body.todo.status, 'done', 'a user confirmation completes the todo in one step')
  assert.equal(confirmed.body.todo.approval.by, 'user')
  assert.equal(confirmed.body.todo.completion.by, 'user')
  assert.deepEqual(confirmed.body.todo.actions, ['reopen', 'update'], 'a done todo can be edited or reopened, never confirmed again')
  console.log('✓ the user confirmed in the panel, which completed the todo in one step')

  // --- 7. the user can also add and finish a todo directly ------------------
  const added = await panel(api, 'POST', '/todos', withProject({ title: '手动加的一条', acceptance: '面板里能看到' }))
  assert.equal(added.status, 201)
  assert.equal(added.body.todo.status, 'open')
  const manualId = added.body.todo.id
  const direct = await panel(api, 'POST', '/action', withProject({ id: manualId, action: 'complete' }))
  assert.equal(direct.body.todo.status, 'done')
  assert.equal(direct.body.todo.completion.by, 'user')
  assert.equal(direct.body.todo.approval.by, 'user', 'the user action itself is the confirmation')
  console.log('✓ a manually added todo can be marked done by the user directly')

  // A finished todo stays editable: the note lands, the status and the approval
  // stay put, and the panel is offered `update` next to `reopen`.
  const editedDone = await panel(api, 'POST', '/action', withProject({ id: manualId, action: 'update', detail: '想到一点补充' }))
  assert.equal(editedDone.status, 200)
  assert.equal(editedDone.body.todo.status, 'done')
  assert.deepEqual(editedDone.body.todo.actions, ['reopen', 'update'])
  const editedDetail = await panel(api, 'GET', `/todo?id=${manualId}&project=${encodeURIComponent(cwd)}`)
  assert.equal(editedDetail.body.todo.detail, '想到一点补充')
  assert.equal(editedDetail.body.todo.approval.by, 'user', 'editing is not a fresh confirmation')
  console.log('✓ a finished todo stays editable without being reopened')

  // --- 8. void needs an explicit confirmation, and a reason ---------------
  const refusedVoid = await call(ctx, 'todo_void', { id: manualId, reason: 'x', confirm: false }, { expectError: true })
  assert.match(refusedVoid.error.message, /confirm/)
  const noReason = await call(ctx, 'todo_void', { id: manualId, confirm: true }, { expectError: true })
  assert.equal(noReason.error.info?.code, 'INVALID_ARGS', 'the registry rejects a missing required argument first')
  console.log('✓ todo_void refuses without `confirm: true` and requires a reason')

  // --- 9. reading it back --------------------------------------------------
  const listed = await call(ctx, 'todo_list', { status: 'done' })
  assert.equal(listed.value.total, 2)
  const detail = await call(ctx, 'todo_get', { id: first })
  assert.equal(detail.value.status, 'done')
  assert.equal(detail.value.answers.length, 1)
  assert.ok(detail.value.history.length >= 7, `history should record every transition (got ${detail.value.history.length})`)
  assert.deepEqual(detail.value.availableActions, [], 'a done todo offers the model nothing')
  assert.match(detail.content[0].text, /History \(/)
  console.log(`✓ todo_get returned the full record with ${detail.value.history.length} history entries`)

  // --- 10. the panel state and the raw file -------------------------------
  const state = await panel(api, 'GET', `/state?project=${encodeURIComponent(cwd)}&limit=0`)
  assert.equal(state.status, 200)
  assert.equal(state.body.levels.project.enabled, true)
  assert.equal(state.body.levels.global.enabled, true)
  assert.equal(state.body.statuses.length, 7, '`confirmed` is gone: seven statuses remain')
  assert.equal(state.body.canDeliver, false, 'no deliverRequest was injected in this API instance')
  const summaries = state.body.levels.project.todos
  assert.equal(summaries.length, 3)
  assert.ok(summaries.every((row) => typeof row.actions === 'object'), 'every row carries the actions the user may run')
  assert.ok(summaries[0].detail === undefined, 'the listing carries summaries, not full records')
  const file = join(cwd, '.dsh', 'todo', 'todos.jsonl')
  const onDisk = await readFile(file, 'utf8')
  assert.equal(onDisk.trim().split('\n').length, 3)
  assert.equal(JSON.parse(onDisk.trim().split('\n')[0]).title, '给 README 补一节安装说明')
  console.log(`✓ the panel state and ${file} agree`)

  // --- 11. unauthenticated / unmarked requests ----------------------------
  const noHeader = await api.handle({ method: 'GET', pathname: `${API_PREFIX}/state`, query: {}, headers: {}, body: undefined })
  assert.equal(noHeader.status, 403)
  const missing = await panel(api, 'GET', '/todo?id=p-nope')
  assert.equal(missing.status, 404)
  console.log('✓ the route requires the marker header and answers 404 for an unknown id')

  // --- 12. the /todo command ----------------------------------------------
  const commandStore = stores.get(cwd)
  const help = await todo.handleTodoCommand(commandStore, '')
  assert.equal(help.kind, 'success')
  assert.match(help.text, /Nothing waiting for you/, 'nothing is pending at this point')
  assert.match(help.text, /^1\. \[p-/m, 'the command lists the todos')
  const commandAdd = await todo.handleTodoCommand(commandStore, 'add 命令行加的一条')
  assert.match(commandAdd.text, /^Added p-/)
  const commandBad = await todo.handleTodoCommand(commandStore, 'nope')
  assert.equal(commandBad.kind, 'error')
  console.log('✓ /todo lists, adds, and rejects an unknown verb')

  // --- 13. delivery into a live session -----------------------------------
  const delivered = []
  const fakeCtx = {
    get: (key) => (key === 'agents'
      ? { get: (sessionId) => (sessionId === 's1' ? { followup: (message) => delivered.push(message) } : undefined) }
      : undefined),
  }
  const outcome = await todo.deliverToAgent(fakeCtx, { sessionId: 's1', prompt: '请完成待办 p-1' })
  assert.equal(outcome.delivered, true)
  assert.equal(outcome.via, 'followup', 'no session API here, so the live agent takes it')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].role, 'user')
  assert.equal(delivered[0].content[0].type, 'text')
  assert.equal(delivered[0].content[0].text, '请完成待办 p-1')
  const noAgent = await todo.deliverToAgent(fakeCtx, { sessionId: 's2', prompt: 'x' })
  assert.equal(noAgent.delivered, false)
  assert.match(noAgent.reason, /no live agent/)
  const noRegistry = await todo.deliverToAgent({ get: () => undefined }, { sessionId: 's1', prompt: 'x' })
  assert.equal(noRegistry.delivered, false)
  console.log('✓ a live session receives the request as a user message')

  // --- 14. choosing the conversation (and the project) to hand off to ------
  const prompted = []
  const madeSessions = []
  const askedForSessions = []
  const pickStore = (directory) => {
    if (!stores.has(directory)) stores.set(directory, new todo.TodoStore({ cwd: directory, globalDir, projectRootMarkers: [] }))
    return stores.get(directory)
  }
  const pickApi = createTodoApi({
    storeFor: pickStore,
    listSessions: async (input) => {
      askedForSessions.push(input)
      return [
        { id: 's-current', title: '当前对话', cwd, projectRoot: cwd, updatedAt: 2, running: false, agentAvailable: true },
        { id: 's-elsewhere', title: '别的项目', cwd: globalDir, projectRoot: globalDir, updatedAt: 1, running: true, agentAvailable: true },
      ]
    },
    createSession: async (input) => { madeSessions.push(input); return { sessionId: 's-made' } },
    deliverRequest: async ({ sessionId, prompt }) => { prompted.push({ sessionId, prompt }); return { delivered: true, via: 'prompt' } },
  })
  const pickPanel = async (method, path, body) => {
    const [pathname, search = ''] = path.split('?')
    return pickApi.handle({
      method,
      pathname: `${API_PREFIX}${pathname}`,
      query: Object.fromEntries(new URLSearchParams(search).entries()),
      headers: { [CLIENT_HEADER]: '1' },
      body,
    })
  }

  // Without a session controller on the host context, the plugin reports "cannot
  // list" instead of guessing — the real ctx here has none.
  assert.equal(await todo.listSessions(ctx, todo.resolveOptions({})), undefined)
  console.log('✓ without a session service the plugin degrades instead of failing')

  const sessionList = await pickPanel('GET', `/sessions?project=${encodeURIComponent(cwd)}&session=s-current`)
  assert.equal(sessionList.status, 200)
  assert.equal(sessionList.body.canList, true)
  assert.equal(sessionList.body.canCreate, true)
  assert.equal(sessionList.body.current, 's-current')
  assert.deepEqual(askedForSessions, [{ limit: 25 }])
  assert.deepEqual(sessionList.body.sessions.map((row) => row.sameProject), [true, false])
  console.log('✓ GET /sessions lists the conversations and flags the same project')

  const handOff = await pickPanel('POST', '/request', withProject({ id: first, scope: 'project', target: 'session', targetSession: 's-elsewhere' }))
  assert.equal(handOff.status, 200)
  assert.equal(handOff.body.delivered, true)
  assert.equal(handOff.body.sessionId, 's-elsewhere', 'the picked conversation wins over the one the panel is in')
  assert.equal(prompted.at(-1).sessionId, 's-elsewhere')
  assert.ok(prompted.at(-1).prompt.includes(first))
  console.log('✓ POST /request delivers to the picked conversation')

  const newSession = await pickPanel('POST', '/request', withProject({ id: manualId, scope: 'project', target: 'new' }))
  assert.equal(newSession.status, 200)
  assert.equal(newSession.body.created, true)
  assert.equal(newSession.body.sessionId, 's-made')
  assert.deepEqual(madeSessions, [{ cwd }], 'a project todo creates its session in its own project')
  console.log('✓ POST /request can create the session it hands the todo to')

  await ctx.fiber.dispose()
  console.log('\ntodo runtime smoke test: PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}
