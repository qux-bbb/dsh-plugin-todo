/**
 * Host-half tests for `dsh-plugin-todo` (`lib/index.js`).
 *
 * These exercise the pure pieces without mounting Cordis: the option resolver
 * (which must mirror the Config schema defaults it duplicates), the one-line
 * renderings, the `/todo` command, and the delivery of a todo into a live
 * session. `apply` itself is deliberately not mounted here.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Config, deliverToAgent, handleTodoCommand, inject, name, renderClaim, renderTodos, resolveOptions } from '../lib/index.js'
import { DEFAULT_LIST_LIMIT, DEFAULT_MAX_DETAIL_LENGTH, DEFAULT_MAX_HISTORY, DEFAULT_MAX_TITLE_LENGTH, DEFAULT_MAX_TODOS, DEFAULT_PROJECT_MARKERS, TodoStore } from '../lib/store.js'

/** @type {string} */
let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'todo-plugin-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A store over a fresh directory, with both levels inside the test root. */
function makeStore(name) {
  const cwd = join(root, name)
  return new TodoStore({
    cwd,
    level: 'both',
    defaultScope: 'project',
    dshHome: root,
    globalDir: join(cwd, '.global'),
    projectRootMarkers: [],
  })
}

describe('module shape', () => {
  it('is a named-export Cordis plugin that needs the tool registry', () => {
    assert.equal(name, 'todo')
    assert.deepEqual(inject, ['tools'])
    assert.equal(typeof Config, 'function')
  })
})

describe('resolveOptions', () => {
  it('applies every documented default', () => {
    const options = resolveOptions()
    assert.equal(options.level, 'both')
    assert.equal(options.defaultScope, 'project')
    assert.equal(options.dshHome, '')
    assert.equal(options.globalDir, '')
    assert.equal(options.projectDir, '')
    assert.equal(options.fileName, 'todos.jsonl')
    assert.deepEqual(options.projectRootMarkers, DEFAULT_PROJECT_MARKERS)
    assert.equal(options.maxTodos, DEFAULT_MAX_TODOS)
    assert.equal(options.maxTitleLength, DEFAULT_MAX_TITLE_LENGTH)
    assert.equal(options.maxDetailLength, DEFAULT_MAX_DETAIL_LENGTH)
    assert.equal(options.maxHistory, DEFAULT_MAX_HISTORY)
    assert.equal(options.defaultLimit, DEFAULT_LIST_LIMIT)
    assert.equal(options.toolPrefix, 'todo')
    assert.equal(options.enableCommand, true)
    assert.equal(options.deliverRequests, true)
    // A non-object config is treated as an empty one rather than crashing.
    assert.deepEqual(resolveOptions('nonsense'), options)
  })

  it('mirrors the Config schema defaults exactly', () => {
    const schema = Config({})
    const options = resolveOptions()
    for (const key of Object.keys(schema)) {
      // The schema is the contract the loader validates against; `apply` may be
      // called with a plain object, so the two must not drift apart.
      assert.deepEqual(options[key], schema[key], `resolveOptions().${key} matches Config({}).${key}`)
    }
    assert.equal(schema.fileName, 'todos.jsonl')
    assert.equal(schema.enableCommand, true)
    assert.equal(schema.deliverRequests, true)
  })

  it('accepts overrides and repairs an unusable tool prefix', () => {
    assert.equal(resolveOptions({ level: 'global', defaultScope: 'global' }).defaultScope, 'global')
    assert.equal(resolveOptions({ level: 'nope' }).level, 'both')
    assert.equal(resolveOptions({ dshHome: '  C:\\home  ' }).dshHome, 'C:\\home')
    assert.equal(resolveOptions({ fileName: '  memos.jsonl  ' }).fileName, 'memos.jsonl')
    assert.equal(resolveOptions({ maxTodos: 5, maxHistory: 0 }).maxHistory, 0)
    // Only non-negative integers are accepted as counts.
    assert.equal(resolveOptions({ maxTodos: -1 }).maxTodos, DEFAULT_MAX_TODOS)
    assert.equal(resolveOptions({ maxTodos: 1.5 }).maxTodos, DEFAULT_MAX_TODOS)

    assert.equal(resolveOptions({ toolPrefix: 'memo' }).toolPrefix, 'memo')
    assert.equal(resolveOptions({ toolPrefix: 'my-todo_2' }).toolPrefix, 'my-todo_2')
    // A padded but otherwise usable name is trimmed, not rejected.
    assert.equal(resolveOptions({ toolPrefix: '  memo  ' }).toolPrefix, 'memo')
    for (const prefix of ['Not a Name', '1leading', 'UPPER', 'has space', '-leading', '']) {
      assert.equal(resolveOptions({ toolPrefix: prefix }).toolPrefix, 'todo', `${JSON.stringify(prefix)} falls back to todo`)
    }
  })

  it('preserves an explicit empty projectRootMarkers list', () => {
    assert.deepEqual(resolveOptions({ projectRootMarkers: [] }).projectRootMarkers, [])
    assert.deepEqual(resolveOptions({ projectRootMarkers: ['.git', '', 7] }).projectRootMarkers, ['.git'])
    assert.deepEqual(resolveOptions({ projectRootMarkers: 'not a list' }).projectRootMarkers, DEFAULT_PROJECT_MARKERS)
  })

  it('honors the two disable switches', () => {
    assert.equal(resolveOptions({ enableCommand: false }).enableCommand, false)
    assert.equal(resolveOptions({ deliverRequests: false }).deliverRequests, false)
    // Anything other than an explicit `false` keeps the feature on.
    assert.equal(resolveOptions({ enableCommand: 0 }).enableCommand, true)
    assert.equal(resolveOptions({ deliverRequests: 'no' }).deliverRequests, true)
  })
})

describe('renderTodos', () => {
  it('renders an empty listing', () => {
    assert.equal(renderTodos([], 0), 'No todos match.')
  })

  it('numbers the rows and flags status, priority, and origin', () => {
    const todos = [
      { id: 'p-1', status: 'proposed', priority: 'high', origin: 'ai', title: 'first', question: null },
      { id: 'p-2', status: 'open', priority: 'normal', origin: 'user', title: 'second', question: 'what exactly?' },
    ]
    const lines = renderTodos(todos, 5).split('\n')
    assert.equal(lines[0], '1. [p-1] (proposed, high, by model) first')
    // A normal priority is not worth a flag; a waiting question is.
    assert.equal(lines[1], '2. [p-2] (open) second | waiting for the user: what exactly?')
    assert.equal(lines[2], '… 3 more todo(s) not shown.')
  })

  it('omits the tail when every matching todo was rendered', () => {
    const todos = [{ id: 'p-1', status: 'done', priority: 'low', origin: 'user', title: 'finished', question: null }]
    const text = renderTodos(todos, 1)
    assert.equal(text, '1. [p-1] (done, low) finished')
    assert.equal(text.includes('not shown'), false)
  })
})

describe('renderClaim', () => {
  const todo = {
    id: 'p-9',
    title: 'claim me',
    detail: 'the detail',
    acceptance: 'the criteria',
    answers: [{ text: 'an earlier answer' }],
  }

  it('carries the acceptance criteria, the answers, and the configured prefix', () => {
    const text = renderClaim(todo, 'memo')
    assert.match(text, /Claimed p-9/)
    assert.ok(text.includes('the detail'))
    assert.ok(text.includes('Acceptance criteria: the criteria'))
    assert.ok(text.includes('- an earlier answer'))
    assert.ok(text.includes('`memo_update`'))
    assert.ok(text.includes('`memo_submit`'))
    // The rule the whole plugin exists for.
    assert.match(text, /You cannot mark it done/)
    // The default prefix is the plain tool prefix.
    assert.ok(renderClaim(todo).includes('`todo_submit`'))
  })

  it('asks for the definition of done when no acceptance criteria were filled in', () => {
    const text = renderClaim({ ...todo, detail: '', acceptance: '', answers: [] }, 'todo')
    assert.ok(text.includes('Detail: (none)'))
    assert.match(text, /Acceptance criteria: \(none — confirm what "done" means with the user before you start\)/)
    assert.equal(text.includes('Answers already on record'), false)
  })
})

describe('handleTodoCommand', () => {
  it('lists the todos and reports what waits for the user', async () => {
    const store = makeStore('command-list')
    const empty = await handleTodoCommand(store, '')
    assert.equal(empty.kind, 'success')
    assert.match(empty.text, /Nothing waiting for you\./)
    assert.match(empty.text, /No todos match\./)
    assert.match(empty.text, /\/todo add <标题>/)

    await store.create({ items: [{ title: 'a proposal from the model' }], origin: 'ai' })
    const listed = await handleTodoCommand(store, '   ')
    assert.equal(listed.kind, 'success')
    assert.match(listed.text, /Waiting for you: 1 proposed/)
    assert.match(listed.text, /a proposal from the model/)
  })

  it('adds a todo as the user, so it is open and not proposed', async () => {
    const store = makeStore('command-add')
    const added = await handleTodoCommand(store, 'add write the report')
    assert.equal(added.kind, 'success')
    assert.match(added.text, /Added p-/)
    const listing = await store.list({ limit: 0 })
    assert.equal(listing.total, 1)
    assert.equal(listing.todos[0].title, 'write the report')
    assert.equal(listing.todos[0].status, 'open')
    assert.equal(listing.todos[0].origin, 'user')
    assert.equal(listing.todos[0].accepted.by, 'user')

    // The verb and the title are separated by whitespace; the rest is the title,
    // with runs of whitespace collapsed into single spaces.
    const multi = await handleTodoCommand(store, 'add   two   words  ')
    assert.match(multi.text, /Added p-.*: two words/)
    assert.equal((await store.list({ query: 'two words', limit: 0 })).total, 1)
  })

  it('marks a todo done directly, which is the user confirmation', async () => {
    const store = makeStore('command-done')
    const added = await handleTodoCommand(store, 'add finish me')
    const id = (await store.list({ limit: 0 })).todos[0].id
    const done = await handleTodoCommand(store, `done ${id}`)
    assert.equal(done.kind, 'success')
    assert.match(done.text, new RegExp(`Marked ${id} done: finish me`))
    const todo = await store.get({ id })
    assert.equal(todo.status, 'done')
    assert.equal(todo.approval.by, 'user')
    assert.equal(todo.completion.by, 'user')
    assert.match(added.text, /Added/)
  })

  it('shows one todo in full, including the actions open to the user', async () => {
    const store = makeStore('command-show')
    await store.create({ items: [{ title: 'inspect me', detail: 'a long detail', acceptance: 'green' }] })
    const id = (await store.list({ limit: 0 })).todos[0].id
    const shown = await handleTodoCommand(store, `show ${id}`)
    assert.equal(shown.kind, 'success')
    assert.ok(shown.text.includes(`[${id}] inspect me`))
    assert.match(shown.text, /Status: open \(request, complete, update, void\)/)
    assert.match(shown.text, /Detail: a long detail/)
    assert.match(shown.text, /Acceptance: green/)

    const unknown = await handleTodoCommand(store, 'show p-nope')
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /No todo p-nope\./)
  })

  it('rejects an unknown verb and a missing argument', async () => {
    const store = makeStore('command-errors')
    const unknown = await handleTodoCommand(store, 'explode everything')
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /未知用法 \/todo explode/)

    assert.equal((await handleTodoCommand(store, 'add')).kind, 'error')
    assert.match((await handleTodoCommand(store, 'add')).text, /用法：\/todo add <标题>/)
    assert.equal((await handleTodoCommand(store, 'add    ')).kind, 'error')
    assert.equal((await handleTodoCommand(store, 'show')).kind, 'error')
    assert.match((await handleTodoCommand(store, 'show')).text, /用法：\/todo show <id>/)
    assert.equal((await handleTodoCommand(store, 'done')).kind, 'error')
    assert.match((await handleTodoCommand(store, 'done')).text, /用法：\/todo done <id>/)
  })

  it('turns a store refusal into an error result instead of throwing', async () => {
    const store = makeStore('command-refusal')
    const result = await handleTodoCommand(store, 'done p-nope')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /no todo "p-nope"/)
  })
})

describe('deliverToAgent', () => {
  it('delivers the prompt as a user-role message into the live session', async () => {
    const messages = []
    const agent = { followup: (message) => messages.push(message) }
    const ctx = { get: (key) => (key === 'agents' ? { get: (id) => (id === 'session-1' ? agent : undefined) } : undefined) }

    const outcome = await deliverToAgent(ctx, { sessionId: 'session-1', prompt: 'please finish this todo' })
    assert.equal(outcome.delivered, true)
    assert.equal(outcome.via, 'followup', 'no session controller here, so the live-agent path delivers it')
    assert.equal(messages.length, 1)
    const message = messages[0]
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, 'user')
    assert.equal(message.content.length, 1)
    assert.equal(message.content[0].type, 'text')
    assert.equal(message.content[0].text, 'please finish this todo')
  })

  it('reports a missing agent registry instead of throwing', async () => {
    for (const ctx of [{ get: () => undefined }, { get: () => ({}) }, {}]) {
      const outcome = await deliverToAgent(ctx, { sessionId: 'session-1', prompt: 'x' })
      assert.equal(outcome.delivered, false)
      assert.match(outcome.reason, /no agent registry/)
    }
  })

  it('reports a session with no live agent', async () => {
    const ctx = { get: (key) => (key === 'agents' ? { get: () => undefined } : undefined) }
    const outcome = await deliverToAgent(ctx, { sessionId: 'session-gone', prompt: 'x' })
    assert.equal(outcome.delivered, false)
    assert.match(outcome.reason, /no live agent/)
    assert.ok(outcome.reason.includes('session-gone'))
    assert.match(outcome.reason, /copy the prompt and send it yourself/)

    const nulled = { get: (key) => (key === 'agents' ? { get: () => null } : undefined) }
    assert.equal((await deliverToAgent(nulled, { sessionId: 's', prompt: 'x' })).delivered, false)
  })

  it('reports an agent that cannot take a follow-up, and one that throws', async () => {
    const withoutFollowup = { get: (key) => (key === 'agents' ? { get: () => ({ id: 'session-1' }) } : undefined) }
    const noFollowup = await deliverToAgent(withoutFollowup, { sessionId: 'session-1', prompt: 'x' })
    assert.equal(noFollowup.delivered, false)
    assert.match(noFollowup.reason, /does not accept follow-up messages/)

    const throwing = { get: (key) => (key === 'agents' ? { get: () => ({ followup() { throw new Error('offline') } }) } : undefined) }
    const failed = await deliverToAgent(throwing, { sessionId: 'session-1', prompt: 'x' })
    assert.equal(failed.delivered, false)
    assert.match(failed.reason, /delivering the request failed: offline/)

    const resolverThrows = {
      get: (key) => (key === 'agents' ? { get: () => { throw new Error('registry closed') } } : undefined),
    }
    const unresolved = await deliverToAgent(resolverThrows, { sessionId: 'session-1', prompt: 'x' })
    assert.equal(unresolved.delivered, false)
    assert.match(unresolved.reason, /could not resolve session session-1: registry closed/)
  })
})
