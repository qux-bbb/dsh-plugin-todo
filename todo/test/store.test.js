/**
 * Store tests for `dsh-plugin-todo`.
 *
 * These tests cover `lib/store.js`: the pure path/normalization helpers, the two
 * level files, the JSON Lines read/write robustness, the listing query, and —
 * most importantly — the workflow machine, because that is where the plugin's
 * two promises live: a proposal is not a todo until the user accepts it, and
 * nothing reaches `done` without a recorded user confirmation.
 *
 * Every store points its two levels inside one per-test temporary directory, so
 * no test can observe or damage another's data.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  DEFAULT_FILE_NAME,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_HISTORY,
  DEFAULT_MAX_TODOS,
  DEFAULT_PROJECT_MARKERS,
  MAX_BATCH,
  STATUSES,
  TodoError,
  TodoStore,
  availableActions,
  compareTodos,
  expandHomePath,
  findProjectRoot,
  needsAttention,
  normalizeDefaultScope,
  normalizeFileName,
  normalizeLevel,
  normalizePriority,
  normalizeStatus,
  normalizeTags,
  optionalText,
  preview,
  requireText,
  resolveDshHome,
  resolveScope,
  summarize,
} from '../lib/store.js'

/** @type {string} */
let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'todo-store-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A fresh, isolated directory inside the test root. */
async function dir(name) {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  return path
}

/** Build a store whose two levels point inside that test's own directory. */
function makeStore(projectCwd, overrides = {}) {
  return new TodoStore({
    cwd: projectCwd,
    level: 'both',
    defaultScope: 'project',
    dshHome: root,
    globalDir: join(projectCwd, '.global'),
    projectRootMarkers: [],
    ...overrides,
  })
}

/**
 * A deterministic, monotonically increasing clock: every call lands one second
 * after the previous one, so `at`/`updatedAt` ordering is exactly the call order.
 */
function clock(start = '2026-01-01T00:00:00.000Z') {
  const base = Date.parse(start)
  let step = 0
  return () => new Date(base + (step += 1000)).toISOString()
}

describe('path resolution', () => {
  it('expands the supported tilde prefixes against the OS home', () => {
    assert.equal(expandHomePath('~'), homedir())
    assert.equal(expandHomePath('~/todos'), join(homedir(), 'todos'))
    assert.equal(expandHomePath('~\\todos'), join(homedir(), 'todos'))
    assert.equal(expandHomePath(join(root, 'plain')), join(root, 'plain'))
  })

  it('prefers configured home, then $DSH_HOME, then ~/.dsh', () => {
    assert.equal(resolveDshHome(join(root, 'custom'), { DSH_HOME: join(root, 'env') }), resolve(join(root, 'custom')))
    assert.equal(resolveDshHome('', { DSH_HOME: join(root, 'env') }), resolve(join(root, 'env')))
    assert.equal(resolveDshHome('   ', { DSH_HOME: '  ' }), resolve(join(homedir(), '.dsh')))
    assert.equal(resolveDshHome(undefined, {}), resolve(join(homedir(), '.dsh')))
  })

  it('walks up to the nearest project root marker', () => {
    const deep = join(root, 'proj', 'a', 'b')
    const seen = []
    const exists = (path) => {
      seen.push(path)
      return path === join(root, 'proj', '.git')
    }
    assert.equal(findProjectRoot(deep, ['.git'], exists), join(root, 'proj'))
    // The probe starts at the caller's own directory, one marker at a time.
    assert.equal(seen[0], join(deep, '.git'))
  })

  it('accepts a marker at the session directory itself', () => {
    const cwd = join(root, 'marker-here')
    assert.equal(findProjectRoot(cwd, ['.git'], (path) => path === join(cwd, '.git')), resolve(cwd))
  })

  it('falls back to cwd with no marker, and probes nothing for an empty marker list', () => {
    assert.equal(findProjectRoot(join(root, 'lonely'), ['.git'], () => false), resolve(join(root, 'lonely')))
    let probes = 0
    assert.equal(findProjectRoot(join(root, 'lonely'), [], () => {
      probes += 1
      return true
    }), resolve(join(root, 'lonely')))
    assert.equal(probes, 0)
    // Non-string and blank markers are ignored, not probed.
    assert.equal(findProjectRoot(join(root, 'lonely'), ['', 7], () => true), resolve(join(root, 'lonely')))
  })

  it('never treats the harness home as a project root by default', () => {
    assert.equal(DEFAULT_PROJECT_MARKERS.includes('.dsh'), false)
  })
})

describe('normalization helpers', () => {
  it('normalizes a configured level and default scope', () => {
    assert.equal(normalizeLevel('global'), 'global')
    assert.equal(normalizeLevel('project'), 'project')
    assert.equal(normalizeLevel('both'), 'both')
    assert.equal(normalizeLevel('everywhere'), 'both')
    assert.equal(normalizeLevel(undefined), 'both')
    assert.equal(normalizeDefaultScope('global'), 'global')
    assert.equal(normalizeDefaultScope('project'), 'project')
    assert.equal(normalizeDefaultScope('both'), 'project')
  })

  it('resolves an omitted scope to the default, or to the only enabled level', () => {
    assert.equal(resolveScope({ level: 'both', defaultScope: 'project' }), 'project')
    assert.equal(resolveScope({ level: 'both', defaultScope: 'global' }), 'global')
    assert.equal(resolveScope({ level: 'global', defaultScope: 'project' }), 'global')
    assert.equal(resolveScope({ level: 'project', defaultScope: 'global' }), 'project')
    assert.equal(resolveScope({ requested: null, level: 'both', defaultScope: 'global' }), 'global')
    assert.equal(resolveScope({ requested: '', level: 'both', defaultScope: 'global' }), 'global')
    assert.equal(resolveScope({ requested: 'global', level: 'both', defaultScope: 'project' }), 'global')
  })

  it('rejects an unknown or disabled explicit scope with a TodoError', () => {
    assert.throws(() => resolveScope({ requested: 'nope', level: 'both', defaultScope: 'project' }), TodoError)
    assert.throws(() => resolveScope({ requested: 'nope', level: 'both', defaultScope: 'project' }), /unknown scope/)
    assert.throws(() => resolveScope({ requested: 'project', level: 'global', defaultScope: 'global' }), TodoError)
    assert.throws(() => resolveScope({ requested: 'project', level: 'global', defaultScope: 'global' }), /disabled/)
  })

  it('keeps a usable todo file name and rejects anything path-like', () => {
    assert.equal(normalizeFileName('../todos.jsonl'), DEFAULT_FILE_NAME)
    assert.equal(normalizeFileName('..'), DEFAULT_FILE_NAME)
    assert.equal(normalizeFileName('.'), DEFAULT_FILE_NAME)
    assert.equal(normalizeFileName('a/b.jsonl'), DEFAULT_FILE_NAME)
    assert.equal(normalizeFileName('a\\b.jsonl'), DEFAULT_FILE_NAME)
    assert.equal(normalizeFileName('  '), DEFAULT_FILE_NAME)
    assert.equal(normalizeFileName(42), DEFAULT_FILE_NAME)
    assert.equal(normalizeFileName(' todos.md '), 'todos.md')
    assert.equal(normalizeFileName('todos.jsonl'), 'todos.jsonl')
  })

  it('normalizes tags, priorities, and statuses read back from disk', () => {
    assert.deepEqual(normalizeTags([' a ', 'a', '', 7, 'b', null]), ['a', 'b'])
    assert.deepEqual(normalizeTags('nope'), [])
    assert.deepEqual(normalizeTags(undefined), [])
    assert.equal(normalizePriority('high'), 'high')
    assert.equal(normalizePriority('low'), 'low')
    assert.equal(normalizePriority('urgent'), 'normal')
    assert.equal(normalizeStatus('review'), 'review')
    assert.equal(normalizeStatus('archived'), 'open')
    // `confirmed` was removed from the state machine; history still reads it.
    assert.equal(normalizeStatus('confirmed'), 'done')
  })

  it('validates required and optional text against a length cap', () => {
    assert.equal(requireText('  hi  ', 'title'), 'hi')
    assert.throws(() => requireText('   ', 'title'), /title must be a non-blank string/)
    assert.throws(() => requireText(42, 'title'), /title must be a non-blank string/)
    assert.throws(() => requireText(undefined, 'title'), /title must be a non-blank string/)
    assert.throws(() => requireText('x'.repeat(11), 'title', 10), /title is 11 characters; the limit is 10/)
    assert.equal(requireText('x'.repeat(10), 'title', 10), 'x'.repeat(10))

    assert.equal(optionalText(undefined, 'detail'), '')
    assert.equal(optionalText(null, 'detail'), '')
    assert.equal(optionalText('  a\nb  ', 'detail'), 'a\nb')
    assert.throws(() => optionalText(42, 'detail'), /detail must be a string/)
    assert.throws(() => optionalText('x'.repeat(11), 'detail', 10), /detail is 11 characters; the limit is 10/)
  })

  it('flattens whitespace into a one-line preview with an ellipsis', () => {
    assert.equal(preview('  a\n\n  b\tc '), 'a b c')
    assert.equal(preview(undefined), '')
    assert.equal(preview('abcdef', 4), 'abc…')
    assert.equal(preview('abcd', 4), 'abcd')
  })
})

describe('TodoStore file layout', () => {
  it('derives both levels from the harness home and the project root', async () => {
    const cwd = await dir('layout')
    const store = new TodoStore({ cwd, dshHome: root, projectRootMarkers: [] })
    assert.equal(store.fileFor('global'), join(root, 'todo', 'todos.jsonl'))
    assert.equal(store.fileFor('project'), join(cwd, '.dsh', 'todo', 'todos.jsonl'))
    assert.deepEqual(store.scopes, ['global', 'project'])
    assert.equal(store.defaultScope, 'project')
    assert.equal(store.level, 'both')
  })

  it('honors custom level directories and a custom file name', async () => {
    const cwd = await dir('layout-custom')
    const store = makeStore(cwd, {
      globalDir: join(root, 'shared-todos'),
      projectDir: join(root, 'project-todos'),
      fileName: 'list.jsonl',
    })
    assert.equal(store.fileFor('global'), join(root, 'shared-todos', 'list.jsonl'))
    assert.equal(store.fileFor('project'), join(root, 'project-todos', 'list.jsonl'))
    assert.equal(store.dirFor('project'), join(root, 'project-todos'))
  })

  it('exposes only the enabled level, and resolves an omitted scope to it', async () => {
    const cwd = await dir('layout-global-only')
    const store = makeStore(cwd, { level: 'global', defaultScope: 'project' })
    assert.deepEqual(store.scopes, ['global'])
    assert.equal(store.fileFor(), join(cwd, '.global', 'todos.jsonl'))
    assert.throws(() => store.fileFor('project'), /disabled/)

    const projectOnly = makeStore(cwd, { level: 'project', defaultScope: 'global' })
    assert.deepEqual(projectOnly.scopes, ['project'])
    assert.equal(projectOnly.fileFor(), join(cwd, '.dsh', 'todo', 'todos.jsonl'))
  })

  it('derives the project root from the nearest ancestor marker', async () => {
    const outer = await dir('layout-root')
    await mkdir(join(outer, '.git'), { recursive: true })
    const inner = join(outer, 'packages', 'app')
    await mkdir(inner, { recursive: true })
    const store = new TodoStore({ cwd: inner, globalDir: join(root, 'layout-root-global') })
    assert.equal(store.fileFor('project'), join(outer, '.dsh', 'todo', 'todos.jsonl'))
  })
})

describe('TodoStore.create', () => {
  it('stores a user todo as open, recorded as accepted by that very action', async () => {
    const cwd = await dir('create-user')
    const store = makeStore(cwd, { now: clock() })
    const result = await store.create({ items: [{ title: '  write tests  ', tags: [' a ', 'a'], priority: 'high' }] })
    const todo = result.todos[0]
    assert.equal(todo.status, 'open')
    assert.equal(todo.title, 'write tests')
    assert.equal(todo.origin, 'user')
    assert.equal(todo.accepted.by, 'user')
    assert.equal(todo.accepted.at, todo.at)
    assert.equal(todo.approval, null)
    assert.equal(todo.completion, null)
    assert.deepEqual(todo.tags, ['a'])
    assert.equal(todo.priority, 'high')
    assert.equal(todo.scope, 'project')
    assert.match(todo.id, /^p-/)
    assert.equal(result.file, store.fileFor('project'))
    assert.equal(result.total, 1)
    assert.equal(result.pruned, 0)
  })

  it('stores a model todo as proposed, with no acceptance on record', async () => {
    const cwd = await dir('create-ai')
    const store = makeStore(cwd, { now: clock() })
    const result = await store.create({ items: [{ title: 'proposed work' }], origin: 'ai' })
    assert.equal(result.todos[0].status, 'proposed')
    assert.equal(result.todos[0].origin, 'ai')
    assert.equal(result.todos[0].accepted, null)
    assert.deepEqual(result.todos[0].history.map((entry) => entry.to), ['proposed'])
  })

  it('prefixes ids per level', async () => {
    const cwd = await dir('create-ids')
    const store = makeStore(cwd)
    const project = await store.create({ items: [{ title: 'in the project' }] })
    const global = await store.create({ items: [{ title: 'everywhere' }], scope: 'global' })
    assert.equal(global.todos[0].scope, 'global')
    assert.match(project.todos[0].id, /^p-/)
    assert.match(global.todos[0].id, /^g-/)
  })

  it('mints unique ids and writes exactly one line per todo', async () => {
    const cwd = await dir('create-unique')
    const store = makeStore(cwd)
    const items = Array.from({ length: 30 }, (_value, index) => ({ title: `todo ${index}` }))
    const created = await store.create({ items })
    assert.equal(created.todos.length, 30)
    assert.equal(new Set(created.todos.map((todo) => todo.id)).size, 30)
    const raw = await readFile(created.file, 'utf8')
    const lines = raw.split('\n').filter((line) => line.length > 0)
    assert.equal(lines.length, 30)
    for (const line of lines) assert.equal(typeof JSON.parse(line).title, 'string')
    assert.equal((await store.list({ limit: 0 })).total, 30)
  })

  it('rejects an empty batch and an oversized batch', async () => {
    const cwd = await dir('create-batch')
    const store = makeStore(cwd)
    assert.throws(() => store.create(), /at least one todo item is required/)
    assert.throws(() => store.create({ items: [] }), /at least one todo item is required/)
    assert.throws(
      () => store.create({ items: Array.from({ length: MAX_BATCH + 1 }, (_value, index) => ({ title: `t${index}` })) }),
      /at most 50 todos may be added in one call/,
    )
    assert.equal(existsSync(store.fileFor('project')), false)
  })

  it('rejects a blank, non-string, or oversized title, and a system origin', async () => {
    const cwd = await dir('create-invalid')
    const store = makeStore(cwd, { maxTitleLength: 10 })
    assert.throws(() => store.create({ items: [{ title: '   ' }] }), /title must be a non-blank string/)
    assert.throws(() => store.create({ items: [{ title: 42 }] }), /title must be a non-blank string/)
    assert.throws(() => store.create({ items: [{ title: 'x'.repeat(11) }] }), /title is 11 characters; the limit is 10/)
    assert.throws(() => store.create({ items: [{ title: 'ok' }], origin: 'system' }), /origin must be `ai` or `user`/)
    assert.equal(existsSync(store.fileFor('project')), false)
  })

  it('creates nothing when one item of a batch is invalid', async () => {
    const cwd = await dir('create-atomic')
    const store = makeStore(cwd)
    assert.throws(() => store.create({ items: [{ title: 'good' }, { title: '   ' }] }), TodoError)
    // Validation runs before the file is touched: nothing was written at all.
    assert.equal(existsSync(store.fileFor('project')), false)
    assert.equal((await store.list()).total, 0)
  })

  it('refuses a create against a disabled level', async () => {
    const cwd = await dir('create-disabled')
    const store = makeStore(cwd, { level: 'global', defaultScope: 'global' })
    assert.throws(() => store.create({ items: [{ title: 'nope' }], scope: 'project' }), /disabled/)
  })
})

describe('TodoStore read robustness', () => {
  it('skips a hand-edited garbage line and a truncated JSON line', async () => {
    const cwd = await dir('read-garbage')
    const store = makeStore(cwd)
    const { file } = await store.create({ items: [{ title: 'good' }] })
    await writeFile(file, [
      'not json at all',
      '{"id":"truncated","title":"unterminated',
      '42',
      '[]',
      'null',
      '"a bare string"',
      '{"id":"no-title"}',
      '',
      '{"id":"p-extra","title":"appended by hand","status":"weird","priority":"urgent","tags":[" keep ",7]}',
    ].join('\n') + '\n', { flag: 'a' })

    const listed = await store.list({ limit: 0 })
    assert.equal(listed.total, 2)
    const extra = listed.todos.find((todo) => todo.id === 'p-extra')
    assert.equal(extra.title, 'appended by hand')
    // Unknown enum values fall back to the documented defaults on read.
    assert.equal(extra.status, 'open')
    assert.equal(extra.priority, 'normal')
    assert.deepEqual(extra.tags, ['keep'])
  })

  it('reads a missing file as an empty list', async () => {
    const cwd = await dir('read-missing')
    const store = makeStore(cwd)
    assert.deepEqual(await store.list({ limit: 0 }), {
      scopes: ['global', 'project'],
      total: 0,
      returned: 0,
      truncated: false,
      counts: Object.fromEntries(STATUSES.map((status) => [status, 0])),
      todos: [],
    })
    assert.equal(await store.get({ id: 'p-anything' }), undefined)
  })
})

describe('TodoStore.list', () => {
  /**
   * Build one store holding one todo of every status, so ordering and filters
   * can be asserted against a complete set.
   * @param {string} name - test directory name.
   * @returns {Promise<{ store: TodoStore, ids: Record<string, string> }>} the store and its ids.
   */
  async function everyStatus(name) {
    const cwd = await dir(name)
    const store = makeStore(cwd, { now: clock() })
    const ids = {}
    const user = async (title, extra = {}) => (await store.create({ items: [{ title, ...extra }] })).todos[0]
    const ai = async (title) => (await store.create({ items: [{ title }], origin: 'ai' })).todos[0]

    ids.proposed = (await ai('proposed one')).id
    ids.open = (await user('open one')).id
    const working = await user('working one')
    await store.act({ id: working.id, action: 'claim', actor: 'ai' })
    ids.working = working.id
    const blocked = await user('blocked one')
    await store.act({ id: blocked.id, action: 'ask', actor: 'ai', question: 'what?' })
    ids.blocked = blocked.id
    const review = await user('review one')
    await store.act({ id: review.id, action: 'claim', actor: 'ai' })
    await store.act({ id: review.id, action: 'submit', actor: 'ai', summary: 'done?' })
    ids.review = review.id
    const done = await user('done one')
    await store.act({ id: done.id, action: 'complete', actor: 'user' })
    ids.done = done.id
    const voided = await user('void one')
    await store.act({ id: voided.id, action: 'void', actor: 'user' })
    ids.void = voided.id
    return { store, ids }
  }

  it('lists what needs a human first, then priority, then the newest activity', async () => {
    const { store } = await everyStatus('list-order')
    const listed = await store.list({ limit: 0 })
    assert.deepEqual(listed.todos.map((todo) => todo.status), [
      'proposed', 'review', 'blocked', 'working', 'open', 'done', 'void',
    ])
    assert.equal(listed.total, 7)
    assert.equal(listed.returned, 7)
    assert.equal(listed.truncated, false)
    assert.deepEqual(listed.scopes, ['global', 'project'])
    for (const todo of listed.todos) assert.equal(todo.file, store.fileFor('project'))
  })

  it('orders one status by priority and then by the most recent activity', async () => {
    const cwd = await dir('list-tiebreak')
    const store = makeStore(cwd, { now: clock() })
    const low = (await store.create({ items: [{ title: 'low', priority: 'low' }] })).todos[0]
    const high = (await store.create({ items: [{ title: 'high', priority: 'high' }] })).todos[0]
    const older = (await store.create({ items: [{ title: 'older' }] })).todos[0]
    const newer = (await store.create({ items: [{ title: 'newer' }] })).todos[0]
    // Touching `older` again makes it the most recently updated normal todo.
    await store.act({ id: older.id, action: 'update', actor: 'user', detail: 'touched last' })

    const listed = await store.list({ limit: 0 })
    assert.deepEqual(listed.todos.map((todo) => todo.title), ['high', 'older', 'newer', 'low'])
    assert.equal(high.priority, 'high')
    assert.equal(newer.priority, 'normal')
    assert.ok(listed.todos.find((todo) => todo.title === 'older').updatedAt > newer.updatedAt)
    assert.equal(low.priority, 'low')

    // compareTodos is the same order the listing uses.
    assert.ok(compareTodos({ status: 'proposed', priority: 'low', updatedAt: 'a' }, { status: 'open', priority: 'high', updatedAt: 'z' }) < 0)
    assert.ok(compareTodos({ status: 'open', priority: 'high', updatedAt: 'a' }, { status: 'open', priority: 'normal', updatedAt: 'z' }) < 0)
    assert.ok(compareTodos({ status: 'open', priority: 'normal', updatedAt: '2026-01-02' }, { status: 'open', priority: 'normal', updatedAt: '2026-01-01' }) < 0)
    assert.equal(compareTodos({ status: 'open', priority: 'normal', updatedAt: '2026-01-01' }, { status: 'open', priority: 'normal', updatedAt: '2026-01-01' }), 0)
  })

  it('filters by status, and rejects an unknown status', async () => {
    const { store } = await everyStatus('list-status')
    const proposed = await store.list({ status: 'proposed', limit: 0 })
    assert.equal(proposed.total, 1)
    assert.equal(proposed.todos[0].status, 'proposed')

    const all = await store.list({ status: 'all', limit: 0 })
    assert.equal(all.total, 7)

    await assert.rejects(() => store.list({ status: 'archived' }), TodoError)
    await assert.rejects(() => store.list({ status: 'archived' }), /unknown status/)
  })

  it('counts after the scope and query filters but before the status filter', async () => {
    const cwd = await dir('list-counts')
    const store = makeStore(cwd)
    await store.create({ items: [{ title: 'alpha project' }] })
    await store.create({ items: [{ title: 'beta proposal' }], origin: 'ai' })
    await store.create({ items: [{ title: 'gamma global' }], scope: 'global' })

    const byStatus = await store.list({ status: 'proposed' })
    assert.equal(byStatus.total, 1)
    assert.equal(byStatus.counts.open, 2)
    assert.equal(byStatus.counts.proposed, 1)
    assert.equal(byStatus.counts.done, 0)
    assert.deepEqual(Object.keys(byStatus.counts).sort(), [...STATUSES].sort())

    const projectOnly = await store.list({ scope: 'project', limit: 0 })
    assert.equal(projectOnly.counts.open, 1)
    assert.equal(projectOnly.counts.proposed, 1)
    assert.deepEqual(projectOnly.scopes, ['project'])

    const queried = await store.list({ query: 'alpha' })
    assert.equal(queried.total, 1)
    assert.equal(queried.counts.open, 1)
    assert.equal(queried.counts.proposed, 0)
  })

  it('filters the query over title, detail, tags, and id', async () => {
    const cwd = await dir('list-query')
    const store = makeStore(cwd)
    await store.create({ items: [{ title: 'Fix the login bug', detail: 'Auth is broken', tags: ['urgent'] }] })
    await store.create({ items: [{ title: 'Write docs' }] })
    const withDetail = await store.create({ items: [{ title: 'Acceptance holder', acceptance: 'a green pipeline' }] })

    assert.equal((await store.list({ query: 'LOGIN' })).total, 1)
    assert.equal((await store.list({ query: 'broken' })).total, 1)
    assert.equal((await store.list({ query: 'urgent' })).total, 1)
    assert.equal((await store.list({ query: withDetail.todos[0].id })).total, 1)
    assert.equal((await store.list({ query: 'pipeline' })).total, 1)
    assert.equal((await store.list({ query: 'nothing here' })).total, 0)
    assert.equal((await store.list({ query: '   ' })).total, 3)
  })

  it('limits the listing, where 0 means every match and an omitted limit uses the default', async () => {
    const cwd = await dir('list-limit')
    const store = makeStore(cwd, { defaultLimit: 2, now: clock() })
    // Three separate calls, so the injected clock makes `three` the newest.
    await store.create({ items: [{ title: 'one' }] })
    await store.create({ items: [{ title: 'two' }] })
    await store.create({ items: [{ title: 'three' }] })

    const limited = await store.list()
    assert.equal(limited.total, 3)
    assert.equal(limited.returned, 2)
    assert.equal(limited.truncated, true)
    // The same todo is listed before its older sibling.
    assert.deepEqual((await store.list({ limit: 0 })).todos.map((todo) => todo.title), ['three', 'two', 'one'])
    assert.equal((await store.list({ limit: 0 })).truncated, false)
    assert.equal((await store.list({ limit: 1 })).returned, 1)
    assert.equal((await store.list({ limit: 2 })).truncated, true)
    assert.equal(DEFAULT_LIST_LIMIT, 50)
    assert.equal(makeStore(cwd).defaultLimit, DEFAULT_LIST_LIMIT)
  })

  it('merges every enabled level when the scope is omitted', async () => {
    const cwd = await dir('list-merge')
    const store = makeStore(cwd)
    await store.create({ items: [{ title: 'project todo' }] })
    await store.create({ items: [{ title: 'global todo' }], scope: 'global' })
    const merged = await store.list({ limit: 0 })
    assert.equal(merged.total, 2)
    assert.deepEqual(merged.todos.map((todo) => todo.scope).sort(), ['global', 'project'])
  })

  it('refuses a listing against a disabled level', async () => {
    const cwd = await dir('list-disabled')
    const store = makeStore(cwd, { level: 'project', defaultScope: 'project' })
    await assert.rejects(() => store.list({ scope: 'global' }), /disabled/)
  })
})

describe('TodoStore.locate and get', () => {
  it('routes an id to the level its prefix names, even with no scope given', async () => {
    const cwd = await dir('locate-prefix')
    const store = makeStore(cwd)
    const project = (await store.create({ items: [{ title: 'project' }] })).todos[0]
    const global = (await store.create({ items: [{ title: 'global' }], scope: 'global' })).todos[0]

    assert.equal((await store.locate({ id: global.id })).scope, 'global')
    assert.equal((await store.locate({ id: global.id })).todo.title, 'global')
    assert.equal((await store.locate({ id: project.id })).scope, 'project')
    assert.equal((await store.get({ id: global.id })).title, 'global')
    // An explicit scope wins and searches only that level.
    assert.equal((await store.locate({ id: project.id, scope: 'project' })).todo.id, project.id)
    assert.equal((await store.locate({ id: global.id, scope: 'project' })).todo, undefined)
  })

  it('returns an undefined todo for an unknown id, and rejects a blank one', async () => {
    const cwd = await dir('locate-missing')
    const store = makeStore(cwd)
    const located = await store.locate({ id: 'p-nope' })
    assert.equal(located.todo, undefined)
    assert.equal(await store.get({ id: 'p-nope' }), undefined)
    assert.equal(await store.get({ id: 'whatever' }), undefined)
    await assert.rejects(() => store.locate({}), /id must be a non-blank string/)
    await assert.rejects(() => store.locate({ id: '  ' }), /id must be a non-blank string/)
    await assert.rejects(() => store.locate({ id: 'x', scope: 'nope' }), /unknown scope/)
  })
})

describe('TodoStore.act — rule 1: only the user accepts a proposal', () => {
  it('refuses `accept` by the model and performs it for the user', async () => {
    const cwd = await dir('rule-accept')
    const store = makeStore(cwd, { now: clock() })
    const { todos } = await store.create({ items: [{ title: 'model idea' }], origin: 'ai' })
    const id = todos[0].id

    await assert.rejects(() => store.act({ id, action: 'accept', actor: 'ai' }), TodoError)
    await assert.rejects(() => store.act({ id, action: 'accept', actor: 'ai' }), /user confirmation/)
    await assert.rejects(() => store.act({ id, action: 'accept', actor: 'system' }), /not allowed for actor system/)
    assert.equal((await store.get({ id })).status, 'proposed')

    const accepted = await store.act({ id, action: 'accept', actor: 'user' })
    assert.equal(accepted.todo.status, 'open')
    assert.equal(accepted.todo.accepted.by, 'user')
    assert.equal(accepted.todo.origin, 'ai')
    assert.equal(accepted.todo.history.at(-1).action, 'accept')
    assert.equal(accepted.todo.history.at(-1).from, 'proposed')
    assert.equal(accepted.todo.history.at(-1).to, 'open')
  })

  it('refuses `accept` on anything that is not a proposal', async () => {
    const cwd = await dir('rule-accept-open')
    const store = makeStore(cwd)
    const { todos } = await store.create({ items: [{ title: 'already real' }] })
    await assert.rejects(() => store.act({ id: todos[0].id, action: 'accept', actor: 'user' }), /accept is not allowed on a open todo/)
  })
})

describe('TodoStore.act — rule 2: nothing is done without a user confirmation', () => {
  it('refuses a model `complete` from every status', async () => {
    const cwd = await dir('rule-complete-ai')
    const store = makeStore(cwd, { now: clock() })
    const open = (await store.create({ items: [{ title: 'open' }] })).todos[0]
    const proposed = (await store.create({ items: [{ title: 'proposed' }], origin: 'ai' })).todos[0]

    await assert.rejects(() => store.act({ id: open.id, action: 'complete', actor: 'ai' }), /not allowed for actor ai/)
    await assert.rejects(() => store.act({ id: proposed.id, action: 'complete', actor: 'ai' }), /not allowed for actor ai/)
    assert.equal((await store.get({ id: open.id })).status, 'open')

    // Even after a submission the model has no completion path: only the user
    // finishes a todo, and that action carries the confirmation.
    await store.act({ id: open.id, action: 'claim', actor: 'ai' })
    await store.act({ id: open.id, action: 'submit', actor: 'ai', summary: 'finished' })
    await assert.rejects(() => store.act({ id: open.id, action: 'complete', actor: 'ai' }), /not allowed for actor ai/)
    await store.act({ id: open.id, action: 'confirm', actor: 'user' })
    const todo = await store.get({ id: open.id })
    assert.equal(todo.status, 'done')
    assert.equal(todo.approval.by, 'user')
    assert.equal(todo.completion.by, 'user')
  })

  it('lets the user complete a todo that was never submitted', async () => {
    const cwd = await dir('rule-complete-user')
    const store = makeStore(cwd, { now: clock() })
    /** Reach one status a user can complete from, then complete it. */
    const reachable = async (status) => {
      const created = status === 'proposed'
        ? (await store.create({ items: [{ title: `from ${status}` }], origin: 'ai' })).todos[0]
        : (await store.create({ items: [{ title: `from ${status}` }] })).todos[0]
      if (status === 'working') await store.act({ id: created.id, action: 'claim', actor: 'ai' })
      if (status === 'blocked') await store.act({ id: created.id, action: 'ask', actor: 'ai', question: 'q' })
      return created.id
    }

    for (const status of ['proposed', 'open', 'working', 'blocked']) {
      const id = await reachable(status)
      assert.equal((await store.get({ id })).status, status)
      const result = await store.act({ id, action: 'complete', actor: 'user' })
      assert.equal(result.todo.status, 'done')
      // The user's own completion *is* the confirmation, recorded on the todo.
      assert.equal(result.todo.approval.by, 'user')
      assert.equal(result.todo.accepted.by, 'user')
      assert.equal(result.todo.completion.by, 'user')
      assert.equal(result.todo.history.at(-1).action, 'complete')
    }
  })

  it('completes a submitted result on `confirm`, recording approval and completion', async () => {
    const cwd = await dir('rule-confirm')
    const store = makeStore(cwd, { now: clock() })
    const created = (await store.create({ items: [{ title: 'submitted' }] })).todos[0]
    await store.act({ id: created.id, action: 'claim', actor: 'ai' })
    await store.act({ id: created.id, action: 'submit', actor: 'ai', summary: 's', evidence: 'e' })

    const confirmed = await store.act({ id: created.id, action: 'confirm', actor: 'user', note: '看过了' })
    assert.equal(confirmed.todo.status, 'done')
    assert.equal(confirmed.todo.approval.by, 'user')
    assert.equal(confirmed.todo.approval.note, '看过了')
    assert.equal(confirmed.todo.completion.by, 'user')
    assert.equal(confirmed.todo.completion.note, '看过了')
    assert.equal(confirmed.todo.history.at(-1).action, 'confirm')
    assert.equal(confirmed.todo.history.at(-1).to, 'done')
  })

  it('refuses `complete` from review, done, and void', async () => {
    const cwd = await dir('rule-complete-terminal')
    const store = makeStore(cwd)
    const done = (await store.create({ items: [{ title: 'done' }] })).todos[0]
    await store.act({ id: done.id, action: 'complete', actor: 'user' })
    const voided = (await store.create({ items: [{ title: 'void' }] })).todos[0]
    await store.act({ id: voided.id, action: 'void', actor: 'user' })
    const review = (await store.create({ items: [{ title: 'review' }] })).todos[0]
    await store.act({ id: review.id, action: 'claim', actor: 'ai' })
    await store.act({ id: review.id, action: 'submit', actor: 'ai', summary: 's' })

    await assert.rejects(() => store.act({ id: review.id, action: 'complete', actor: 'user' }), /confirm the submitted result instead/)
    await assert.rejects(() => store.act({ id: done.id, action: 'complete', actor: 'user' }), /already done/)
    await assert.rejects(() => store.act({ id: done.id, action: 'complete', actor: 'ai' }), /not allowed for actor ai/)
    await assert.rejects(() => store.act({ id: voided.id, action: 'complete', actor: 'user' }), /already void/)
    await assert.rejects(() => store.act({ id: voided.id, action: 'complete', actor: 'ai' }), /not allowed for actor ai/)
    // A refused action never moved the review todo.
    assert.equal((await store.get({ id: review.id })).status, 'review')
  })
})

describe('TodoStore.act — the happy path', () => {
  it('walks propose → accept → claim → ask → answer → submit → confirm', async () => {
    const cwd = await dir('act-happy')
    const store = makeStore(cwd, { now: clock() })
    const id = (await store.create({ items: [{ title: 'ship it' }], origin: 'ai' })).todos[0].id

    const accepted = await store.act({ id, action: 'accept', actor: 'user' })
    assert.equal(accepted.todo.status, 'open')
    const claimed = await store.act({ id, action: 'claim', actor: 'ai' })
    assert.equal(claimed.todo.status, 'working')
    assert.equal(claimed.todo.agent.by, 'ai')

    const blocked = await store.act({ id, action: 'ask', actor: 'ai', question: 'which branch?' })
    assert.equal(blocked.todo.status, 'blocked')
    assert.equal(blocked.todo.question, 'which branch?')
    assert.equal(blocked.todo.history.at(-1).note, 'which branch?')

    const answered = await store.act({ id, action: 'answer', actor: 'user', text: 'main, please' })
    assert.equal(answered.todo.status, 'working')
    assert.equal(answered.todo.question, null)
    assert.deepEqual(answered.todo.answers.map((answer) => answer.text), ['main, please'])
    assert.equal(answered.todo.answers[0].by, 'user')
    assert.equal(answered.todo.detail, 'main, please')

    const submitted = await store.act({ id, action: 'submit', actor: 'ai', summary: 'pushed to main', evidence: 'commit abc' })
    assert.equal(submitted.todo.status, 'review')
    assert.equal(submitted.todo.submission.summary, 'pushed to main')
    assert.equal(submitted.todo.submission.evidence, 'commit abc')

    const completed = await store.act({ id, action: 'confirm', actor: 'user' })
    assert.equal(completed.todo.status, 'done')
    assert.equal(completed.todo.approval.by, 'user')
    assert.equal(completed.todo.completion.by, 'user')

    // One history entry per transition, each naming who did what to whom.
    const todo = await store.get({ id })
    assert.deepEqual(todo.history.map((entry) => [entry.action, entry.from, entry.to, entry.by]), [
      ['create', null, 'proposed', 'ai'],
      ['accept', 'proposed', 'open', 'user'],
      ['claim', 'open', 'working', 'ai'],
      ['ask', 'working', 'blocked', 'ai'],
      ['answer', 'blocked', 'working', 'user'],
      ['submit', 'working', 'review', 'ai'],
      ['confirm', 'review', 'done', 'user'],
    ])
    for (const entry of todo.history) assert.equal(typeof entry.at, 'string')
  })

  it('appends an answer to the existing detail instead of replacing it', async () => {
    const cwd = await dir('act-answer-detail')
    const store = makeStore(cwd)
    const id = (await store.create({ items: [{ title: 'has detail', detail: 'context' }] })).todos[0].id
    await store.act({ id, action: 'ask', actor: 'ai', question: 'and then?' })
    await store.act({ id, action: 'answer', actor: 'user', text: 'then this' })
    const todo = await store.get({ id })
    assert.equal(todo.detail, 'context\n\nthen this')
    assert.deepEqual(todo.answers.map((answer) => answer.text), ['then this'])
    assert.equal(todo.question, null)
  })

  it('uses a supplied note on a transition, and a preview of the answer otherwise', async () => {
    const cwd = await dir('act-notes')
    const store = makeStore(cwd)
    const id = (await store.create({ items: [{ title: 'notes' }] })).todos[0].id
    const accepted = await store.act({ id, action: 'claim', actor: 'user', note: 'starting now' })
    assert.equal(accepted.todo.history.at(-1).note, 'starting now')
    await store.act({ id, action: 'ask', actor: 'ai', question: 'why?' })
    const answered = await store.act({ id, action: 'answer', actor: 'ai', text: 'because\nreasons' })
    assert.equal(answered.todo.history.at(-1).note, 'because reasons')
  })
})

describe('TodoStore.act — refusals and special transitions', () => {
  it('refuses an unknown action name and an unknown id', async () => {
    const cwd = await dir('act-unknown')
    const store = makeStore(cwd)
    const id = (await store.create({ items: [{ title: 'known' }] })).todos[0].id
    await assert.rejects(() => store.act({ id, action: 'explode', actor: 'user' }), /unknown action "explode"/)
    await assert.rejects(() => store.act({ id, actor: 'user' }), /unknown action undefined/)
    await assert.rejects(() => store.act({ id: 'p-nope', action: 'claim', actor: 'ai' }), /no todo "p-nope"/)
    await assert.rejects(() => store.act({ action: 'claim', actor: 'ai' }), /id must be a non-blank string/)
  })

  it('refuses an action from the wrong source status', async () => {
    const cwd = await dir('act-wrong-status')
    const store = makeStore(cwd)
    const id = (await store.create({ items: [{ title: 'open' }] })).todos[0].id
    await assert.rejects(() => store.act({ id, action: 'submit', actor: 'ai' }), /submit is not allowed on a open todo/)
    await assert.rejects(() => store.act({ id, action: 'answer', actor: 'user', text: 'x' }), /answer is not allowed on a open todo/)
    await assert.rejects(() => store.act({ id, action: 'confirm', actor: 'user' }), /confirm is not allowed on a open todo/)
    await assert.rejects(() => store.act({ id, action: 'reopen', actor: 'user' }), /reopen is not allowed on a open todo/)
  })

  it('keeps `submit` for the model and `confirm` for the user', async () => {
    const cwd = await dir('act-actors')
    const store = makeStore(cwd)
    const id = (await store.create({ items: [{ title: 'work' }] })).todos[0].id
    await store.act({ id, action: 'claim', actor: 'ai' })
    await assert.rejects(() => store.act({ id, action: 'submit', actor: 'user', summary: 's' }), /submit is not allowed for actor user/)
    await store.act({ id, action: 'submit', actor: 'ai', summary: 's' })
    await assert.rejects(() => store.act({ id, action: 'confirm', actor: 'ai' }), /user confirmation/)
    await assert.rejects(() => store.act({ id, action: 'confirm', actor: 'system' }), /not allowed for actor system/)
  })

  it('requires a reason when the model voids a todo, but never for the user', async () => {
    const cwd = await dir('act-void-reason')
    const store = makeStore(cwd)
    const ai = (await store.create({ items: [{ title: 'ai void' }] })).todos[0]
    const user = (await store.create({ items: [{ title: 'user void' }] })).todos[0]
    const rejected = (await store.create({ items: [{ title: 'rejected ai void' }] })).todos[0]

    await assert.rejects(() => store.act({ id: ai.id, action: 'void', actor: 'ai' }), /void requires a non-blank `reason`/)
    await assert.rejects(() => store.act({ id: ai.id, action: 'void', actor: 'ai', reason: '   ' }), /void requires a non-blank `reason`/)
    assert.equal((await store.get({ id: ai.id })).status, 'open')

    const voided = await store.act({ id: ai.id, action: 'void', actor: 'ai', reason: 'duplicate of p-other' })
    assert.equal(voided.todo.status, 'void')
    assert.equal(voided.todo.voided.reason, 'duplicate of p-other')
    assert.equal(voided.todo.voided.by, 'ai')
    assert.equal(voided.todo.history.at(-1).action, 'void')

    const userVoided = await store.act({ id: user.id, action: 'void', actor: 'user' })
    assert.equal(userVoided.todo.status, 'void')
    assert.equal(typeof userVoided.todo.voided.reason, 'string')
    assert.equal(userVoided.todo.voided.by, 'user')

    // A note may stand in for the reason on the model's side.
    const byNote = await store.act({ id: rejected.id, action: 'void', actor: 'ai', note: 'no longer needed' })
    assert.equal(byNote.todo.voided.reason, 'no longer needed')
  })

  it('voids a proposal on `reject`, and returns a review to working', async () => {
    const cwd = await dir('act-reject')
    const store = makeStore(cwd)
    const proposal = (await store.create({ items: [{ title: 'bad idea' }], origin: 'ai' })).todos[0]
    const rejected = await store.act({ id: proposal.id, action: 'reject', actor: 'user' })
    assert.equal(rejected.todo.status, 'void')
    assert.equal(rejected.todo.voided.reason, '驳回提议')
    assert.equal(rejected.todo.voided.by, 'user')
    assert.equal(rejected.todo.history.at(-1).action, 'reject')
    assert.equal(rejected.todo.history.at(-1).to, 'void')

    const job = (await store.create({ items: [{ title: 'job' }] })).todos[0]
    await store.act({ id: job.id, action: 'claim', actor: 'ai' })
    await store.act({ id: job.id, action: 'submit', actor: 'ai', summary: 'not right' })
    const sentBack = await store.act({ id: job.id, action: 'reject', actor: 'user', reason: 'wrong output' })
    assert.equal(sentBack.todo.status, 'working')
    assert.equal(sentBack.todo.approval, null)
    assert.equal(sentBack.todo.submission.summary, 'not right')
    assert.equal(sentBack.todo.history.at(-1).action, 'reject')
    assert.equal(sentBack.todo.history.at(-1).note, 'wrong output')
    assert.equal(sentBack.todo.history.at(-1).to, 'working')

    // Only the user rejects.
    await store.act({ id: job.id, action: 'submit', actor: 'ai', summary: 'again' })
    await assert.rejects(() => store.act({ id: job.id, action: 'reject', actor: 'ai' }), /reject is not allowed for actor ai/)
  })

  it('refuses a `reject` on a status it does not apply to', async () => {
    const cwd = await dir('act-reject-status')
    const store = makeStore(cwd)
    const id = (await store.create({ items: [{ title: 'plain' }] })).todos[0].id
    await assert.rejects(() => store.act({ id, action: 'reject', actor: 'user' }), /reject applies to a proposed or review todo/)
  })

  it('edits a todo with `update`, and refuses an empty patch or a void todo', async () => {
    const cwd = await dir('act-update')
    const store = makeStore(cwd, { now: clock() })
    const id = (await store.create({ items: [{ title: 'before', tags: ['a'] }] })).todos[0].id
    const updated = await store.act({ id, action: 'update', actor: 'ai', title: 'after', priority: 'high', tags: ['b', 'b'] })
    assert.equal(updated.todo.title, 'after')
    assert.equal(updated.todo.priority, 'high')
    assert.deepEqual(updated.todo.tags, ['b'])
    assert.equal(updated.todo.status, 'open')
    assert.equal(typeof updated.todo.editedAt, 'string')
    assert.equal(updated.todo.history.at(-1).action, 'update')

    await assert.rejects(() => store.act({ id, action: 'update', actor: 'user' }), /update needs at least one of/)
    await assert.rejects(() => store.act({ id, action: 'update', actor: 'user', title: '  ' }), /title must be a non-blank string/)

    await store.act({ id, action: 'void', actor: 'user' })
    await assert.rejects(() => store.act({ id, action: 'update', actor: 'user', title: 'never' }), /update is not allowed on a void todo/)
    await assert.rejects(() => store.act({ id, action: 'void', actor: 'user' }), /void is not allowed on a void todo/)
  })

  it('`reopen` clears the completion, the approval, and the void record', async () => {
    const cwd = await dir('act-reopen')
    const store = makeStore(cwd)
    const done = (await store.create({ items: [{ title: 'done' }] })).todos[0]
    await store.act({ id: done.id, action: 'complete', actor: 'user' })
    const reopened = await store.act({ id: done.id, action: 'reopen', actor: 'user' })
    assert.equal(reopened.todo.status, 'open')
    assert.equal(reopened.todo.completion, null)
    assert.equal(reopened.todo.approval, null)
    assert.equal(reopened.todo.voided, null)
    // Reopening is not a fresh acceptance: the original one stays on record.
    assert.equal(reopened.todo.accepted.by, 'user')

    const voided = (await store.create({ items: [{ title: 'void' }] })).todos[0]
    await store.act({ id: voided.id, action: 'void', actor: 'ai', reason: 'changed my mind' })
    const back = await store.act({ id: voided.id, action: 'reopen', actor: 'user' })
    assert.equal(back.todo.status, 'open')
    assert.equal(back.todo.voided, null)

    // Only the user reopens.
    await assert.rejects(() => store.act({ id: voided.id, action: 'reopen', actor: 'ai' }), /reopen is not allowed for actor ai/)
  })

  it('`reopen` sends a started todo back to the queue, dropping the claim and the question', async () => {
    const cwd = await dir('act-reopen-started')
    const store = makeStore(cwd)
    const make = async (title) => (await store.create({ items: [{ title }] })).todos[0].id

    const working = await make('working one')
    await store.act({ id: working, action: 'claim', actor: 'ai' })
    const requeued = await store.act({ id: working, action: 'reopen', actor: 'user' })
    assert.equal(requeued.todo.status, 'open')
    assert.equal(requeued.todo.agent, null, 'the claim goes with the reopen')

    const blocked = await make('blocked one')
    await store.act({ id: blocked, action: 'claim', actor: 'ai' })
    await store.act({ id: blocked, action: 'ask', actor: 'ai', question: 'which environment?' })
    await store.act({ id: blocked, action: 'answer', actor: 'user', text: 'production' })
    await store.act({ id: blocked, action: 'ask', actor: 'ai', question: 'and the region?' })
    const cleared = await store.act({ id: blocked, action: 'reopen', actor: 'user' })
    assert.equal(cleared.todo.status, 'open')
    assert.equal(cleared.todo.question, null, 'the pending question goes with the claim')
    assert.equal(cleared.todo.answers.length, 1, 'the answers the user already gave stay on record')
    assert.equal(cleared.todo.accepted.by, 'user', 'it stays an accepted todo, not a fresh one')

    // A started todo is still in a session's hands until the user takes it back.
    await assert.rejects(() => store.act({ id: blocked, action: 'reopen', actor: 'ai' }), /reopen is not allowed for actor ai/)
  })

  it('`claim` moves a todo to working and records the agent', async () => {
    const cwd = await dir('act-claim')
    const store = makeStore(cwd)
    const id = (await store.create({ items: [{ title: 'idle' }] })).todos[0].id
    const claimed = await store.act({ id, action: 'claim', actor: 'user' })
    assert.equal(claimed.todo.status, 'working')
    assert.equal(claimed.todo.agent.by, 'user')
    assert.equal((await store.act({ id, action: 'claim', actor: 'ai' })).todo.agent.by, 'ai')
  })

  it('`ask` requires a question and moves the todo to blocked', async () => {
    const cwd = await dir('act-ask')
    const store = makeStore(cwd)
    const id = (await store.create({ items: [{ title: 'unclear' }] })).todos[0].id
    await assert.rejects(() => store.act({ id, action: 'ask', actor: 'ai' }), /question must be a non-blank string/)
    const asked = await store.act({ id, action: 'ask', actor: 'ai', question: 'which environment?' })
    assert.equal(asked.todo.status, 'blocked')
    assert.equal(asked.todo.question, 'which environment?')
  })
})

describe('TodoStore history', () => {
  it('keeps the newest `maxHistory` entries and always the first one', async () => {
    const cwd = await dir('history-cap')
    const store = makeStore(cwd, { now: clock(), maxHistory: 3 })
    const id = (await store.create({ items: [{ title: 'cap' }], origin: 'ai' })).todos[0].id
    await store.act({ id, action: 'accept', actor: 'user' })
    await store.act({ id, action: 'claim', actor: 'ai' })
    await store.act({ id, action: 'ask', actor: 'ai', question: 'q' })
    await store.act({ id, action: 'answer', actor: 'user', text: 'a' })
    await store.act({ id, action: 'submit', actor: 'ai', summary: 's' })
    await store.act({ id, action: 'confirm', actor: 'user' })

    const todo = await store.get({ id })
    assert.equal(todo.history.length, 3)
    assert.equal(todo.history[0].action, 'create')
    assert.deepEqual(todo.history.map((entry) => entry.action), ['create', 'submit', 'confirm'])
  })

  it('caps history at 50 by default', async () => {
    const cwd = await dir('history-default')
    const store = makeStore(cwd)
    assert.equal(store.maxHistory, DEFAULT_MAX_HISTORY)
    const id = (await store.create({ items: [{ title: 'many edits' }] })).todos[0].id
    for (let index = 0; index < DEFAULT_MAX_HISTORY + 10; index += 1) {
      await store.act({ id, action: 'update', actor: 'ai', title: `edit ${index}` })
    }
    const todo = await store.get({ id })
    assert.equal(todo.history.length, DEFAULT_MAX_HISTORY)
    assert.equal(todo.history[0].action, 'create')
    assert.equal(todo.history.at(-1).action, 'update')
  })
})

describe('TodoStore pruning', () => {
  it('drops finished todos from the oldest end first, keeping open work', async () => {
    const cwd = await dir('prune-finished')
    const store = makeStore(cwd, { now: clock(), maxTodos: 3 })
    const batch = await store.create({ items: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] })
    assert.equal(batch.total, 3)
    // Finish `a`, then void `c`: with three todos nothing is pruned yet.
    await store.act({ id: batch.todos[0].id, action: 'complete', actor: 'user' })
    await store.act({ id: batch.todos[2].id, action: 'void', actor: 'user' })

    const added = await store.create({ items: [{ title: 'd' }] })
    assert.equal(added.pruned, 1)
    assert.equal(added.total, 3)
    const kept = await store.list({ limit: 0 })
    assert.deepEqual(kept.todos.map((todo) => todo.title).sort(), ['b', 'c', 'd'])
    // The open todo survived; the finished one went first.
    assert.equal(kept.todos.find((todo) => todo.title === 'b').status, 'open')
  })

  it('drops the oldest todos when nothing is finished yet', async () => {
    const cwd = await dir('prune-fallback')
    const store = makeStore(cwd, { now: clock(), maxTodos: 2 })
    await store.create({ items: [{ title: 'a' }, { title: 'b' }] })
    const added = await store.create({ items: [{ title: 'c' }, { title: 'd' }] })
    assert.equal(added.pruned, 2)
    assert.equal(added.total, 2)
    // Both survivors share one timestamp, so they keep their file order.
    assert.deepEqual((await store.list({ limit: 0 })).todos.map((todo) => todo.title), ['c', 'd'])
  })

  it('disables pruning entirely with maxTodos: 0', async () => {
    const cwd = await dir('prune-disabled')
    const store = makeStore(cwd, { maxTodos: 0 })
    const added = await store.create({ items: [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }] })
    assert.equal(added.pruned, 0)
    assert.equal(added.total, 4)
    assert.equal((await store.list({ limit: 0 })).total, 4)
    assert.equal(DEFAULT_MAX_TODOS, 2000)
  })
})

describe('TodoStore concurrency', () => {
  it('does not interleave 20 concurrent creates on one store instance', async () => {
    const cwd = await dir('concurrent-one')
    const store = makeStore(cwd)
    await Promise.all(Array.from({ length: 20 }, (_value, index) => store.create({ items: [{ title: `todo ${index}` }] })))
    const raw = await readFile(store.fileFor('project'), 'utf8')
    const lines = raw.split('\n').filter((line) => line.length > 0)
    assert.equal(lines.length, 20)
    for (const line of lines) assert.equal(typeof JSON.parse(line).title, 'string')
    assert.equal((await store.list({ limit: 0 })).total, 20)
    assert.equal(new Set((await store.list({ limit: 0 })).todos.map((todo) => todo.id)).size, 20)
  })

  it('serializes two separate store instances aimed at the same file', async () => {
    const cwd = await dir('concurrent-two')
    const first = makeStore(cwd)
    const second = makeStore(cwd)
    assert.equal(first.fileFor('project'), second.fileFor('project'))

    await Promise.all(Array.from({ length: 20 }, (_value, index) =>
      (index % 2 === 0 ? first : second).create({ items: [{ title: `from ${index % 2 === 0 ? 'first' : 'second'} ${index}` }] })))

    const raw = await readFile(first.fileFor('project'), 'utf8')
    const lines = raw.split('\n').filter((line) => line.length > 0)
    assert.equal(lines.length, 20)
    assert.equal((await second.list({ limit: 0 })).total, 20)
  })
})

describe('TodoStore.clear', () => {
  it('removes only the requested level and reports what it removed', async () => {
    const cwd = await dir('clear-one')
    const store = makeStore(cwd)
    await store.create({ items: [{ title: 'project one' }, { title: 'project two' }] })
    await store.create({ items: [{ title: 'global one' }], scope: 'global' })

    const report = await store.clear({ scope: 'project' })
    assert.equal(report.removed, 2)
    assert.deepEqual(report.scopes, ['project'])
    assert.equal(report.files[0].scope, 'project')
    assert.equal(report.files[0].file, store.fileFor('project'))
    assert.equal(report.files[0].removed, 2)
    assert.equal((await store.list({ scope: 'project' })).total, 0)
    assert.equal((await store.list({ scope: 'global' })).total, 1)
    assert.equal(existsSync(store.fileFor('project')), false)
  })

  it('clears every enabled level when the scope is omitted', async () => {
    const cwd = await dir('clear-all')
    const store = makeStore(cwd)
    await store.create({ items: [{ title: 'project' }] })
    await store.create({ items: [{ title: 'global' }], scope: 'global' })
    const report = await store.clear()
    assert.deepEqual(report.scopes, ['global', 'project'])
    assert.equal(report.removed, 2)
    assert.equal((await store.clear()).removed, 0)
  })

  it('refuses a disabled level', async () => {
    const cwd = await dir('clear-disabled')
    const store = makeStore(cwd, { level: 'global', defaultScope: 'global' })
    await assert.rejects(() => store.clear({ scope: 'project' }), /disabled/)
  })
})

describe('summaries and action tables', () => {
  it('offers the documented actions to the user and the model', () => {
    assert.deepEqual(availableActions('proposed', 'user'), ['accept', 'complete', 'update', 'void'])
    // `request` means "start this todo in a session", so it belongs to `open`
    // alone: a working todo already has a session, and a blocked one is waiting
    // on the user's answer, which another session cannot supply. A started todo
    // gets `reopen` instead, the explicit way back to the queue.
    assert.deepEqual(availableActions('open', 'user'), ['request', 'complete', 'update', 'void'])
    assert.deepEqual(availableActions('working', 'user'), ['complete', 'update', 'reopen', 'void'])
    assert.deepEqual(availableActions('blocked', 'user'), ['answer', 'complete', 'update', 'reopen', 'void'])
    assert.deepEqual(availableActions('review', 'user'), ['confirm', 'reject', 'update', 'void'])
    assert.deepEqual(availableActions('done', 'user'), ['reopen'])
    assert.deepEqual(availableActions('void', 'user'), ['reopen'])
    // The panel asks as the user; an unknown status simply offers nothing.
    assert.deepEqual(availableActions('proposed'), ['accept', 'complete', 'update', 'void'])
    assert.deepEqual(availableActions('nonsense'), [])

    // The model may not accept its own proposal nor confirm its own result, and
    // it has no `complete` action anywhere.
    assert.deepEqual(availableActions('proposed', 'ai'), ['update', 'void'])
    assert.deepEqual(availableActions('review', 'ai'), ['update', 'void'])
    assert.deepEqual(availableActions('done', 'ai'), [])
    assert.deepEqual(availableActions('void', 'ai'), [])
    for (const status of STATUSES) assert.ok(!availableActions(status, 'ai').includes('complete'), `the model is offered complete (${status})`)
    // The returned list is a copy, so a caller cannot corrupt the table.
    availableActions('open', 'user').push('hacked')
    assert.deepEqual(availableActions('open', 'user'), ['request', 'complete', 'update', 'void'])
  })

  it('marks exactly the statuses that wait for a human decision', () => {
    assert.deepEqual(STATUSES.filter((status) => needsAttention(status)), ['proposed', 'blocked', 'review'])
    for (const status of ['open', 'working', 'done', 'void']) assert.equal(needsAttention(status), false)
  })

  it('projects a todo onto a compact row without the full detail', async () => {
    const cwd = await dir('summarize')
    const store = makeStore(cwd, { now: clock() })
    const id = (await store.create({
      items: [{ title: 'summary', detail: `long\n\ndetail ${'x'.repeat(300)}`, acceptance: 'green', tags: ['t'] }],
    })).todos[0].id
    await store.act({ id, action: 'claim', actor: 'ai' })
    await store.act({ id, action: 'ask', actor: 'ai', question: 'more?' })
    await store.act({ id, action: 'answer', actor: 'user', text: 'here you go' })

    const todo = await store.get({ id })
    const summary = summarize(todo, 20)
    assert.equal('detail' in summary, false)
    assert.equal('history' in summary, false)
    assert.equal('answers' in summary, false)
    assert.equal(summary.id, id)
    assert.equal(summary.title, 'summary')
    assert.equal(summary.status, 'working')
    // The server decides whether a row waits for the user; `working` does not.
    assert.equal(summary.attention, false)
    assert.equal(summary.answerCount, 1)
    assert.equal(summary.question, null)
    assert.equal(summary.preview.length, 20)
    assert.match(summary.preview, /…$/)
    assert.equal(summary.acceptance, 'green')
    assert.deepEqual(summary.actions, availableActions('working', 'user'))
    assert.deepEqual(summary.tags, ['t'])
    assert.equal(summary.accepted.by, 'user')
  })

  it('previews a submission and defaults to a 200-character preview', () => {
    const todo = {
      id: 'p-1',
      scope: 'project',
      title: 't',
      status: 'review',
      priority: 'normal',
      tags: [],
      origin: 'ai',
      at: 'a',
      updatedAt: 'a',
      detail: 'd',
      acceptance: '',
      question: null,
      answers: [],
      submission: { at: 'a', by: 'ai', summary: 's'.repeat(300) },
      accepted: null,
      approval: null,
      completion: null,
      voided: null,
    }
    const summary = summarize(todo)
    assert.equal(summary.preview, 'd')
    // A submission waits for the user's confirmation.
    assert.equal(summary.attention, true)
    assert.equal(summary.submission.summary.length, 200)
    assert.match(summary.submission.summary, /…$/)
  })
})

describe('clock injection', () => {
  it('uses the injected clock for creation, transitions, and history', async () => {
    const cwd = await dir('clock')
    const stamps = ['2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z', '2026-05-03T00:00:00.000Z']
    let index = 0
    const store = makeStore(cwd, { now: () => stamps[Math.min(index++, stamps.length - 1)] })

    const created = (await store.create({ items: [{ title: 'timed' }] })).todos[0]
    assert.equal(created.at, stamps[0])
    assert.equal(created.updatedAt, stamps[0])
    assert.equal(created.history[0].at, stamps[0])

    const claimed = await store.act({ id: created.id, action: 'claim', actor: 'ai' })
    assert.equal(claimed.todo.updatedAt, stamps[1])
    assert.equal(claimed.todo.at, stamps[0])
    assert.equal(claimed.todo.history.at(-1).at, stamps[1])

    const completed = await store.act({ id: created.id, action: 'complete', actor: 'user' })
    assert.equal(completed.todo.updatedAt, stamps[2])
    assert.equal(completed.todo.approval.at, stamps[2])
    assert.equal(completed.todo.completion.at, stamps[2])
  })
})
