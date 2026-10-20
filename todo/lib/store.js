/**
 * Todo storage and workflow machine for `dsh-plugin-todo`.
 *
 * A todo is one line of JSON in a JSON Lines file, one file per level:
 *
 * - `global`  → `<dshHome>/todo/todos.jsonl` — shared by every project.
 * - `project` → `<projectRoot>/.dsh/todo/todos.jsonl` — one file per project,
 *   where `projectRoot` is the nearest ancestor holding a project root marker.
 *
 * The store also owns the *workflow*, not just the bytes: every status change
 * goes through {@link TodoStore.act}, which enforces the two rules the plugin
 * exists for:
 *
 * 1. A todo the model proposed is not a todo yet — a user must accept it
 *    (`proposed` → `open`).
 * 2. A todo is never marked `done` without a recorded user confirmation, and
 *    only the user can mark one done: `confirm` on a submitted result, or
 *    `complete` on a todo that was never submitted. Either action *is* the
 *    confirmation and is recorded on the todo; the model has no path to `done`.
 *
 * Every mutation is a whole-file atomic rewrite (`.tmp` + rename) serialized
 * per file path, so two stores pointed at the same file cannot interleave.
 *
 * @module dsh-plugin-todo/store
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The two todo levels, in listing order. */
export const SCOPES = ['global', 'project']
/** The `level` config values: one level, or both. */
export const LEVELS = ['global', 'project', 'both']
/**
 * Every todo status.
 *
 * - `proposed`  — the model proposed it; awaiting the user's acceptance.
 * - `open`      — a real todo, not started.
 * - `working`   — the model (or the user) started it.
 * - `blocked`   — started, but more information is needed from the user.
 * - `review`    — the model reports it finished; the user confirms, which completes it.
 * - `done`      — completed, always with the user's recorded confirmation.
 * - `void`      — cancelled / withdrawn, kept for the record.
 */
export const STATUSES = ['proposed', 'open', 'working', 'blocked', 'review', 'done', 'void']
/** Statuses a todo never leaves on its own. */
export const TERMINAL_STATUSES = ['done', 'void']
/** Todo priorities, highest first. */
export const PRIORITIES = ['high', 'normal', 'low']
/** Who performed a transition. */
export const ACTORS = ['ai', 'user', 'system']
/** Default todo file name inside a level directory. */
export const DEFAULT_FILE_NAME = 'todos.jsonl'
/**
 * Default project-root markers, checked in order at every ancestor. Deliberately
 * excludes `.dsh`: the harness home is itself `<home>/.dsh`, so treating it as a
 * marker would resolve every path under the user's home to the harness home and
 * silently merge project todos into the global level.
 */
export const DEFAULT_PROJECT_MARKERS = ['.git', '.hg', '.svn']
/** Default per-file todo cap (oldest finished todos are pruned past it). */
export const DEFAULT_MAX_TODOS = 2000
/** Default title length cap, in characters. */
export const DEFAULT_MAX_TITLE_LENGTH = 200
/** Default detail / acceptance-criteria length cap, in characters. */
export const DEFAULT_MAX_DETAIL_LENGTH = 8000
/** Default number of history entries kept per todo. */
export const DEFAULT_MAX_HISTORY = 50
/** Default `limit` for a listing that omits one. */
export const DEFAULT_LIST_LIMIT = 50
/** Maximum todos one `create` call may add. */
export const MAX_BATCH = 50

/** Listing order: what needs a human first, what is finished last. */
const STATUS_RANK = { proposed: 0, review: 1, blocked: 2, working: 3, open: 4, done: 5, void: 6 }
/** Priority ordering inside one status rank. */
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 }

/** A user-facing input or workflow problem. */
export class TodoError extends Error {
  /**
   * @param {string} message - the problem, phrased for the caller.
   */
  constructor(message) {
    super(message)
    this.name = 'TodoError'
  }
}

/**
 * The actions a user may run from the panel, per status. `request` is not a
 * store action: it hands the todo to the model (see the host half).
 */
const USER_ACTIONS = {
  proposed: ['accept', 'complete', 'update', 'void'],
  open: ['request', 'complete', 'update', 'void'],
  working: ['request', 'complete', 'update', 'void'],
  blocked: ['answer', 'request', 'complete', 'update', 'void'],
  review: ['confirm', 'reject', 'update', 'void'],
  done: ['reopen'],
  void: ['reopen'],
}

/**
 * The actions the model may run, per status. Deliberately empty for `proposed`
 * (a user must accept it) and for `review` (a user must confirm it) apart from
 * withdrawal / bookkeeping, which is the whole point of the plugin. There is no
 * `complete` anywhere: only the user finishes a todo.
 */
const AI_ACTIONS = {
  proposed: ['update', 'void'],
  open: ['claim', 'update', 'void'],
  working: ['ask', 'submit', 'update', 'void'],
  blocked: ['ask', 'answer', 'submit', 'update', 'void'],
  review: ['update', 'void'],
  done: [],
  void: [],
}

/**
 * The legal source statuses of each plain transition, per actor.
 * `complete`, `reject`, `update`, and `void` carry extra rules and are handled
 * explicitly in {@link TodoStore#applyAction}.
 */
const TRANSITIONS = {
  accept: { from: ['proposed'], to: 'open', actors: ['user'] },
  claim: { from: ['open', 'working', 'blocked'], to: 'working', actors: ['ai', 'user'] },
  ask: { from: ['proposed', 'open', 'working', 'blocked'], to: 'blocked', actors: ['ai', 'user', 'system'] },
  answer: { from: ['blocked'], to: 'working', actors: ['ai', 'user', 'system'] },
  submit: { from: ['working', 'blocked'], to: 'review', actors: ['ai'] },
  confirm: { from: ['review'], to: 'done', actors: ['user'] },
  reject: { from: ['proposed', 'review'], to: null, actors: ['user'] },
  complete: { from: ['proposed', 'open', 'working', 'blocked'], to: 'done', actors: ['user'] },
  reopen: { from: ['done', 'void', 'review', 'proposed'], to: 'open', actors: ['user'] },
  void: { from: STATUSES.filter((status) => status !== 'void'), to: 'void', actors: ['ai', 'user'] },
  update: { from: STATUSES.filter((status) => status !== 'void'), to: null, actors: ['ai', 'user', 'system'] },
}

/**
 * The statuses the user may complete directly: for a todo that was never
 * submitted, the user's own completion *is* the confirmation. A `review` todo
 * is completed with `confirm` instead, so `review` has exactly one way out.
 */
const USER_COMPLETABLE = ['proposed', 'open', 'working', 'blocked']

/**
 * The actions available for one status and actor.
 * @param {string} status - a todo status.
 * @param {'ai' | 'user'} [actor] - who is asking; the panel asks as `user`.
 * @returns {string[]} action names, in menu order.
 */
export function availableActions(status, actor = 'user') {
  const table = actor === 'ai' ? AI_ACTIONS : USER_ACTIONS
  return [...(table[status] ?? [])]
}

/**
 * Whether a status means "needs a human decision right now".
 * @param {string} status - a todo status.
 * @returns {boolean} true for `proposed`, `review`, and `blocked`.
 */
export function needsAttention(status) {
  return status === 'proposed' || status === 'review' || status === 'blocked'
}

/**
 * Expand the supported tilde prefixes against the operating-system home.
 * @param {string} path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns {string} the expanded path.
 */
export function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the DeepSeek Harness home. Precedence: explicit config, `$DSH_HOME`,
 * then `~/.dsh` — the same order the harness itself uses.
 * @param {string} [configured] - explicit harness-home override.
 * @param {Record<string, string | undefined>} [env] - environment mapping.
 * @returns {string} the absolute harness home.
 */
export function resolveDshHome(configured, env = process.env) {
  const fromConfig = typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : undefined
  const fromEnv = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0 ? env.DSH_HOME.trim() : undefined
  return resolve(expandHomePath(fromConfig ?? fromEnv ?? join(homedir(), '.dsh')))
}

/**
 * Find the project root for a session working directory: the nearest ancestor
 * (starting at `cwd`) that contains one of `markers`, else `cwd` itself.
 * @param {string} cwd - the session working directory.
 * @param {readonly string[]} [markers] - project root markers; empty entries are ignored.
 * @param {(path: string) => boolean} [exists] - existence probe, injectable for tests.
 * @returns {string} the absolute project root.
 */
export function findProjectRoot(cwd, markers = DEFAULT_PROJECT_MARKERS, exists = existsSync) {
  const start = resolve(cwd)
  // Trim every marker: a padded `' .git '` would probe `<dir>/ .git ` and never
  // match, silently resolving a project under a repository to the session
  // directory and filing project todos beside the global ones.
  const wanted = markers
    .map((marker) => (typeof marker === 'string' ? marker.trim() : ''))
    .filter((marker) => marker.length > 0)
  if (wanted.length === 0) return start
  let current = start
  for (;;) {
    if (wanted.some((marker) => exists(join(current, marker)))) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/**
 * Normalize a configured level.
 * @param {unknown} value - raw level.
 * @returns {'global' | 'project' | 'both'} the accepted level.
 */
export function normalizeLevel(value) {
  return LEVELS.includes(value) ? value : 'both'
}

/**
 * Normalize a configured default scope.
 * @param {unknown} value - raw scope.
 * @returns {'global' | 'project'} the accepted scope.
 */
export function normalizeDefaultScope(value) {
  return SCOPES.includes(value) ? value : 'project'
}

/**
 * Resolve the level a single call addresses.
 *
 * An explicit scope must be both a known scope and enabled for this
 * deployment; an omitted scope falls back to the configured default, or to the
 * only enabled level when that default is disabled.
 * @param {object} input - resolution input.
 * @param {string} [input.requested] - the scope the call asked for, if any.
 * @param {'global' | 'project' | 'both'} input.level - enabled level(s).
 * @param {'global' | 'project'} input.defaultScope - preferred omitted scope.
 * @returns {'global' | 'project'} the scope to use.
 * @throws {TodoError} when an explicit scope is unknown or disabled.
 */
export function resolveScope({ requested, level, defaultScope }) {
  const enabled = level === 'both' ? [...SCOPES] : [level]
  if (requested === undefined || requested === null || requested === '') {
    return enabled.includes(defaultScope) ? defaultScope : enabled[0]
  }
  if (!SCOPES.includes(requested)) {
    throw new TodoError(`unknown scope ${JSON.stringify(requested)}: expected one of ${SCOPES.join(', ')}`)
  }
  if (!enabled.includes(requested)) {
    throw new TodoError(`scope ${JSON.stringify(requested)} is disabled: this todo list exposes ${enabled.join(' + ')} (change \`level\` to enable it)`)
  }
  return requested
}

/**
 * Keep a usable todo file name: a bare file name, never a path.
 * @param {unknown} value - configured file name.
 * @returns {string} the accepted file name.
 */
export function normalizeFileName(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length > 0 && !trimmed.includes('/') && !trimmed.includes('\\') && trimmed !== '.' && trimmed !== '..') return trimmed
  }
  return DEFAULT_FILE_NAME
}

/**
 * Accept a non-negative integer count, else a fallback.
 * @param {unknown} value - configured count.
 * @param {number} fallback - value used when the input is not a non-negative integer.
 * @returns {number} the accepted count.
 */
export function normalizeCount(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * Normalize todo tags: trimmed, non-empty, de-duplicated strings.
 * @param {unknown} tags - raw tags.
 * @returns {string[]} the accepted tags.
 */
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const trimmed = tag.trim()
    if (trimmed.length > 0) seen.add(trimmed)
  }
  return [...seen]
}

/**
 * Normalize a priority.
 * @param {unknown} value - raw priority.
 * @returns {'high' | 'normal' | 'low'} the accepted priority.
 */
export function normalizePriority(value) {
  return PRIORITIES.includes(value) ? value : 'normal'
}

/**
 * Normalize a status read back from disk.
 *
 * `confirmed` was a status before the state machine dropped it: a user
 * confirmation now completes the todo directly. Historical records still spell
 * it that way, so they are mapped forward instead of being lost.
 * @param {unknown} value - raw status.
 * @returns {string} a known status, defaulting to `open`.
 */
export function normalizeStatus(value) {
  if (STATUSES.includes(value)) return value
  return value === 'confirmed' ? 'done' : 'open'
}

/**
 * Normalize an actor read back from disk.
 * @param {unknown} value - raw actor.
 * @returns {'ai' | 'user' | 'system'} the accepted actor.
 */
export function normalizeActor(value) {
  return ACTORS.includes(value) ? value : 'user'
}

/**
 * Validate and trim a required single-line field.
 * @param {unknown} value - raw value.
 * @param {string} field - field name for the error message.
 * @param {number} max - length cap; 0 disables it.
 * @returns {string} the accepted text.
 * @throws {TodoError} when the value is missing, blank, or too long.
 */
export function requireText(value, field, max = 0) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) throw new TodoError(`${field} must be a non-blank string`)
  if (max > 0 && text.length > max) throw new TodoError(`${field} is ${text.length} characters; the limit is ${max}`)
  return text
}

/**
 * Validate and trim an optional multi-line field.
 * @param {unknown} value - raw value.
 * @param {string} field - field name for the error message.
 * @param {number} max - length cap; 0 disables it.
 * @returns {string} the accepted text (may be empty).
 * @throws {TodoError} when the value is not a string or is too long.
 */
export function optionalText(value, field, max = 0) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new TodoError(`${field} must be a string`)
  const text = value.trim()
  if (max > 0 && text.length > max) throw new TodoError(`${field} is ${text.length} characters; the limit is ${max}`)
  return text
}

/**
 * Truncate text for a one-line preview.
 * @param {string} text - source text.
 * @param {number} max - maximum characters.
 * @returns {string} the preview.
 */
export function preview(text, max = 200) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * Coerce one parsed JSON Lines entry into a todo, or `undefined` when the line
 * is not a todo (a hand-edited or truncated line is skipped, never fatal).
 * @param {unknown} value - parsed line.
 * @param {'global' | 'project'} scope - level the line was read from.
 * @returns {Record<string, unknown> | undefined} the todo.
 */
function toTodo(value, scope) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  if (typeof value.title !== 'string') return undefined
  return {
    id: typeof value.id === 'string' ? value.id : '',
    scope: SCOPES.includes(value.scope) ? value.scope : scope,
    title: value.title,
    detail: typeof value.detail === 'string' ? value.detail : '',
    acceptance: typeof value.acceptance === 'string' ? value.acceptance : '',
    tags: normalizeTags(value.tags),
    priority: normalizePriority(value.priority),
    status: normalizeStatus(value.status),
    origin: value.origin === 'ai' ? 'ai' : 'user',
    at: typeof value.at === 'string' ? value.at : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    editedAt: typeof value.editedAt === 'string' ? value.editedAt : null,
    question: typeof value.question === 'string' && value.question.length > 0 ? value.question : null,
    answers: Array.isArray(value.answers) ? value.answers.filter((answer) => typeof answer?.text === 'string') : [],
    agent: value.agent ?? null,
    submission: value.submission ?? null,
    accepted: value.accepted ?? null,
    approval: value.approval ?? null,
    completion: value.completion ?? null,
    voided: value.voided ?? null,
    history: Array.isArray(value.history) ? value.history.filter((entry) => typeof entry?.action === 'string') : [],
  }
}

/**
 * Whether a filesystem error means "nothing is stored there yet".
 * @param {unknown} error - a thrown error.
 * @returns {boolean} true for absence errors.
 */
function isAbsent(error) {
  return typeof error === 'object' && error !== null && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/**
 * Write queues keyed by absolute file path, shared by every store instance in
 * this process, so two sessions addressing the same file cannot interleave.
 * @type {Map<string, Promise<unknown>>}
 */
const writeQueues = new Map()

/**
 * Run one operation after every earlier operation on the same file settled.
 * @template T
 * @param {string} file - absolute file being mutated.
 * @param {() => Promise<T>} operation - the queued operation.
 * @returns {Promise<T>} the operation's own outcome.
 */
function withFileLock(file, operation) {
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const run = previous.then(operation, operation)
  const tail = run.then(() => undefined, () => undefined)
  writeQueues.set(file, tail)
  void tail.then(() => {
    if (writeQueues.get(file) === tail) writeQueues.delete(file)
  })
  return run
}

/**
 * Append one entry to a history list, keeping the newest `max` entries and
 * always keeping the oldest one (the record of how the todo started).
 * @param {Array<Record<string, unknown>>} history - existing history.
 * @param {Record<string, unknown>} entry - the new entry.
 * @param {number} max - cap; 0 keeps everything.
 * @returns {Array<Record<string, unknown>>} the new history.
 */
function appendHistory(history, entry, max) {
  const next = [...history, entry]
  if (max <= 0 || next.length <= max) return next
  return [next[0], ...next.slice(next.length - (max - 1))]
}

/**
 * One todo list over a fixed working directory.
 */
export class TodoStore {
  /**
   * @param {object} [options] - store configuration.
   * @param {string} [options.cwd] - session working directory (project scope is derived from it).
   * @param {string} [options.dshHome] - harness home override.
   * @param {'global' | 'project' | 'both'} [options.level] - enabled level(s).
   * @param {'global' | 'project'} [options.defaultScope] - scope used when a call omits one.
   * @param {string} [options.globalDir] - global todo directory override.
   * @param {string} [options.projectDir] - project todo directory override.
   * @param {string} [options.fileName] - todo file name inside a level directory.
   * @param {readonly string[]} [options.projectRootMarkers] - project root markers.
   * @param {number} [options.maxTodos] - per-file cap; 0 disables pruning.
   * @param {number} [options.maxTitleLength] - title length cap in characters.
   * @param {number} [options.maxDetailLength] - detail / acceptance length cap in characters.
   * @param {number} [options.maxHistory] - history entries kept per todo; 0 keeps all.
   * @param {number} [options.defaultLimit] - default listing limit.
   * @param {() => string} [options.now] - clock, injectable for tests.
   */
  constructor(options = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd())
    this.dshHome = resolveDshHome(options.dshHome)
    this.level = normalizeLevel(options.level)
    this.defaultScope = normalizeDefaultScope(options.defaultScope)
    this.fileName = normalizeFileName(options.fileName)
    this.globalDir = options.globalDir ? resolve(expandHomePath(options.globalDir)) : join(this.dshHome, 'todo')
    this.projectRoot = findProjectRoot(this.cwd, options.projectRootMarkers ?? DEFAULT_PROJECT_MARKERS)
    this.projectDir = options.projectDir ? resolve(expandHomePath(options.projectDir)) : join(this.projectRoot, '.dsh', 'todo')
    this.maxTodos = normalizeCount(options.maxTodos, DEFAULT_MAX_TODOS)
    this.maxTitleLength = normalizeCount(options.maxTitleLength, DEFAULT_MAX_TITLE_LENGTH)
    this.maxDetailLength = normalizeCount(options.maxDetailLength, DEFAULT_MAX_DETAIL_LENGTH)
    this.maxHistory = normalizeCount(options.maxHistory, DEFAULT_MAX_HISTORY)
    this.defaultLimit = normalizeCount(options.defaultLimit, DEFAULT_LIST_LIMIT)
    this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()
    /** @type {number} per-store id sequence. */
    this.sequence = 0
  }

  /** The levels this deployment exposes, in listing order. */
  get scopes() {
    return this.level === 'both' ? [...SCOPES] : [this.level]
  }

  /**
   * The directory holding one level's todos.
   * @param {'global' | 'project'} [scope] - requested level; defaults to the configured default.
   * @returns {string} the absolute directory (not necessarily created yet).
   * @throws {TodoError} when the scope is unknown or disabled.
   */
  dirFor(scope) {
    const target = resolveScope({ requested: scope, level: this.level, defaultScope: this.defaultScope })
    return target === 'global' ? this.globalDir : this.projectDir
  }

  /**
   * The todo file of one level.
   * @param {'global' | 'project'} [scope] - requested level.
   * @returns {string} the absolute todo file path.
   */
  fileFor(scope) {
    return join(this.dirFor(scope), this.fileName)
  }

  /**
   * Locate a todo: in the requested level, or — when no level is given — in the
   * one its id prefix names, then in every enabled level.
   * @param {object} input - lookup input.
   * @param {string} input.id - todo id.
   * @param {'global' | 'project'} [input.scope] - level to search; omitted searches by id prefix.
   * @returns {Promise<{ scope: 'global' | 'project' | undefined, todo: Record<string, unknown> | undefined }>} the location and record.
   * @throws {TodoError} when the id is blank or an explicit scope is unusable.
   */
  async locate({ id, scope } = {}) {
    if (typeof id !== 'string' || id.trim().length === 0) throw new TodoError('id must be a non-blank string')
    const wanted = id.trim()
    if (scope !== undefined && scope !== null && scope !== '') {
      const target = resolveScope({ requested: scope, level: this.level, defaultScope: this.defaultScope })
      return { scope: target, todo: await this.#find(target, wanted) }
    }
    const preferred = wanted.startsWith('g-') ? 'global' : wanted.startsWith('p-') ? 'project' : undefined
    const order = preferred !== undefined && this.scopes.includes(preferred)
      ? [preferred, ...this.scopes.filter((candidate) => candidate !== preferred)]
      : this.scopes
    for (const candidate of order) {
      const todo = await this.#find(candidate, wanted)
      if (todo !== undefined) return { scope: candidate, todo }
    }
    return { scope: order[0], todo: undefined }
  }

  /**
   * One todo, by id.
   * @param {object} input - lookup input.
   * @param {string} input.id - todo id.
   * @param {'global' | 'project'} [input.scope] - level to search.
   * @returns {Promise<Record<string, unknown> | undefined>} the todo, or undefined.
   */
  async get({ id, scope } = {}) {
    return (await this.locate({ id, scope })).todo
  }

  /**
   * Add todos. A todo the model proposed enters `proposed` (it needs the user's
   * acceptance); one the user added enters `open` and is recorded as accepted by
   * that very action.
   * @param {object} input - creation input.
   * @param {Array<{ title: string, detail?: string, acceptance?: string, tags?: string[], priority?: string }>} input.items - the todos to add.
   * @param {'global' | 'project'} [input.scope] - target level.
   * @param {'ai' | 'user'} [input.origin] - who is adding them.
   * @returns {Promise<{ todos: Array<Record<string, unknown>>, file: string, total: number, scope: string, pruned: number }>} the created todos.
   * @throws {TodoError} when no item, too many items, or an item is invalid.
   */
  create({ items, scope, origin = 'user' } = {}) {
    const list = Array.isArray(items) ? items : []
    if (list.length === 0) throw new TodoError('at least one todo item is required')
    if (list.length > MAX_BATCH) throw new TodoError(`at most ${MAX_BATCH} todos may be added in one call (got ${list.length})`)
    const by = normalizeActor(origin)
    if (by === 'system') throw new TodoError('origin must be `ai` or `user`')
    const target = resolveScope({ requested: scope, level: this.level, defaultScope: this.defaultScope })
    const at = this.now()
    const created = list.map((item) => this.#draft(item, target, by, at))
    return this.#mutate(target, (todos) => ({
      todos: [...todos, ...created],
      result: { todos: created, scope: target },
    }))
  }

  /**
   * List todos.
   * @param {object} [query] - listing query.
   * @param {'global' | 'project'} [query.scope] - restrict to one level; omitted reads every enabled level.
   * @param {string} [query.status] - one status, or `all`/omitted for every status.
   * @param {string} [query.query] - case-insensitive substring filter over title, detail, tags, and id.
   * @param {number} [query.limit] - maximum todos returned; `0` means all, omitted uses the configured default.
   * @returns {Promise<{ scopes: string[], total: number, returned: number, truncated: boolean, counts: Record<string, number>, todos: Array<Record<string, unknown>> }>} the listing.
   * @throws {TodoError} when the status filter is unknown.
   */
  async list({ scope, status, query, limit } = {}) {
    const scopes = scope === undefined || scope === null || scope === ''
      ? this.scopes
      : [resolveScope({ requested: scope, level: this.level, defaultScope: this.defaultScope })]
    const wanted = status === undefined || status === null || status === '' ? 'all' : String(status)
    if (wanted !== 'all' && !STATUSES.includes(wanted)) {
      throw new TodoError(`unknown status ${JSON.stringify(wanted)}: expected one of ${STATUSES.join(', ')} or all`)
    }
    /** @type {Array<Record<string, unknown>>} */
    let todos = []
    for (const target of scopes) {
      const file = this.fileFor(target)
      for (const todo of await this.#read(target)) todos.push({ ...todo, file })
    }
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
    if (needle.length > 0) {
      todos = todos.filter((todo) =>
        todo.title.toLowerCase().includes(needle)
        || todo.detail.toLowerCase().includes(needle)
        || todo.acceptance.toLowerCase().includes(needle)
        || todo.id.toLowerCase().includes(needle)
        || todo.tags.some((tag) => tag.toLowerCase().includes(needle)))
    }
    const counts = Object.fromEntries(STATUSES.map((candidate) => [candidate, 0]))
    for (const todo of todos) counts[todo.status] = (counts[todo.status] ?? 0) + 1
    const matching = wanted === 'all' ? todos : todos.filter((todo) => todo.status === wanted)
    matching.sort(compareTodos)
    const total = matching.length
    const take = limit === 0 ? total : normalizeCount(limit, this.defaultLimit)
    const picked = matching.slice(0, take)
    return { scopes, total, returned: picked.length, truncated: picked.length < total, counts, todos: picked }
  }

  /**
   * Run one workflow action on one todo.
   *
   * The transition table is per actor, and the two confirmation rules of the
   * plugin are enforced here:
   *
   * - the model may not accept its own proposal (`proposed` → `open` is a user action);
   * - only the user can reach `done` (`confirm` from `review`, `complete` from a
   *   status that was never submitted), so a `done` todo always carries a
   *   recorded user confirmation.
   * @param {object} input - action input.
   * @param {string} input.id - todo id.
   * @param {string} input.action - one of the action names in {@link availableActions}.
   * @param {'ai' | 'user' | 'system'} [input.actor] - who is acting.
   * @param {'global' | 'project'} [input.scope] - level holding the todo; omitted locates by id.
   * @param {string} [input.note] - free-form note recorded on the transition.
   * @param {string} [input.reason] - reason required by `void` when the model does it.
   * @param {string} [input.question] - what information `ask` needs from the user.
   * @param {string} [input.text] - the answer `answer` records.
   * @param {string} [input.summary] - what `submit` reports as done.
   * @param {string} [input.evidence] - optional evidence for `submit`.
   * @param {string} [input.title] - replacement title for `update`.
   * @param {string} [input.detail] - replacement detail for `update`.
   * @param {string} [input.acceptance] - replacement acceptance criteria for `update`.
   * @param {string[]} [input.tags] - replacement tags for `update`.
   * @param {string} [input.priority] - replacement priority for `update`.
   * @returns {Promise<{ todo: Record<string, unknown>, file: string, total: number, scope: string, pruned: number }>} the updated todo.
   * @throws {TodoError} when the todo is unknown or the transition is not allowed.
   */
  async act(input = {}) {
    const { id, action } = input
    const by = normalizeActor(input.actor ?? 'user')
    if (typeof action !== 'string' || !Object.hasOwn(TRANSITIONS, action)) {
      throw new TodoError(`unknown action ${JSON.stringify(action)}: expected one of ${Object.keys(TRANSITIONS).join(', ')}`)
    }
    const located = await this.locate({ id, scope: input.scope })
    if (located.todo === undefined) {
      throw new TodoError(`no todo ${JSON.stringify(id)} in the ${input.scope ? located.scope : this.scopes.join(' + ')} level`)
    }
    const target = located.scope
    return this.#mutate(target, (todos) => {
      const index = todos.findIndex((todo) => todo.id === located.todo.id)
      if (index < 0) throw new TodoError(`no todo ${JSON.stringify(id)} in the ${target} level`)
      const next = this.#applyAction(todos[index], action, by, input)
      const updated = [...todos]
      updated[index] = next
      return { todos: updated, result: { todo: next } }
    })
  }

  /**
   * Delete one level's todo file, or of every enabled level.
   * @param {object} [input] - clear input.
   * @param {'global' | 'project'} [input.scope] - level to clear; omitted clears every enabled level.
   * @returns {Promise<{ scopes: string[], removed: number, files: Array<{ scope: string, file: string, removed: number }> }>} the deletion report.
   */
  async clear({ scope } = {}) {
    const scopes = scope === undefined || scope === null || scope === ''
      ? this.scopes
      : [resolveScope({ requested: scope, level: this.level, defaultScope: this.defaultScope })]
    const report = { scopes, removed: 0, files: [] }
    for (const target of scopes) {
      const file = this.fileFor(target)
      const removed = await withFileLock(file, async () => {
        const count = (await this.#read(target)).length
        await rm(file, { force: true })
        return count
      })
      report.files.push({ scope: target, file, removed })
      report.removed += removed
    }
    return report
  }

  /**
   * Build a new todo from caller input. Validation happens before any file is
   * touched, so a bad item in a batch creates nothing.
   * @param {Record<string, unknown>} item - raw item.
   * @param {'global' | 'project'} scope - target level.
   * @param {'ai' | 'user'} origin - who is adding it.
   * @param {string} at - ISO timestamp.
   * @returns {Record<string, unknown>} the todo.
   */
  #draft(item, scope, origin, at) {
    const source = typeof item === 'object' && item !== null ? item : {}
    const title = requireText(source.title, 'title', this.maxTitleLength)
    return {
      id: this.#nextId(scope),
      scope,
      title,
      detail: optionalText(source.detail, 'detail', this.maxDetailLength),
      acceptance: optionalText(source.acceptance, 'acceptance', this.maxDetailLength),
      tags: normalizeTags(source.tags),
      priority: normalizePriority(source.priority),
      status: origin === 'ai' ? 'proposed' : 'open',
      origin,
      at,
      updatedAt: at,
      editedAt: null,
      question: null,
      answers: [],
      agent: null,
      submission: null,
      accepted: origin === 'user' ? { at, by: 'user', note: 'created by the user' } : null,
      approval: null,
      completion: null,
      voided: null,
      history: [{ at, by: origin, action: 'create', from: null, to: origin === 'ai' ? 'proposed' : 'open', note: null }],
    }
  }

  /**
   * Apply one transition to one todo, enforcing the actor and source-status
   * rules. Pure: it never touches the filesystem.
   * @param {Record<string, unknown>} previous - the todo before the action.
   * @param {string} action - the action name.
   * @param {'ai' | 'user' | 'system'} by - who is acting.
   * @param {Record<string, unknown>} input - raw action input.
   * @returns {Record<string, unknown>} the todo after the action.
   * @throws {TodoError} when the transition is not allowed.
   */
  #applyAction(previous, action, by, input) {
    const rule = TRANSITIONS[action]
    const at = this.now()
    if (!rule.actors.includes(by)) {
      throw new TodoError(
        by === 'ai' && (action === 'accept' || action === 'confirm')
          ? `${action} is a user confirmation: the user must do it in the todo panel (the model cannot confirm its own proposal or result)`
          : `action ${action} is not allowed for actor ${by} (allowed: ${rule.actors.join(', ')})`,
      )
    }
    const note = optionalText(input.note, 'note', this.maxDetailLength) || null

    // `complete` is the user's shortcut for a todo that was never submitted: the
    // user's own completion *is* the confirmation. A submitted todo (`review`) is
    // completed with `confirm`, so `review` has exactly one way out.
    if (action === 'complete') {
      if (!USER_COMPLETABLE.includes(previous.status)) {
        throw new TodoError(
          previous.status === 'review'
            ? `todo ${JSON.stringify(previous.id)} is in review: confirm the submitted result instead of marking it done`
            : `todo ${JSON.stringify(previous.id)} is already ${previous.status}`,
        )
      }
    } else if (action === 'reject') {
      // Rejecting a proposal cancels it; rejecting a submission sends it back.
      if (previous.status === 'proposed') {
        const reason = note ?? (optionalText(input.reason, 'reason', this.maxDetailLength) || '驳回提议')
        return this.#void(previous, by, at, reason, 'reject')
      }
      if (previous.status !== 'review') throw new TodoError(`reject applies to a proposed or review todo; ${JSON.stringify(previous.id)} is ${previous.status}`)
      return this.#transition(previous, {
        action, to: 'working', by, at, note: note ?? (optionalText(input.reason, 'reason', this.maxDetailLength) || null),
        patch: { approval: null, submission: previous.submission ?? null },
      })
    } else if (!rule.from.includes(previous.status)) {
      throw new TodoError(`${action} is not allowed on a ${previous.status} todo (${JSON.stringify(previous.id)}); allowed from: ${rule.from.join(', ')}`)
    }

    switch (action) {
      case 'accept':
        return this.#transition(previous, { action, to: 'open', by, at, note, patch: { accepted: { at, by: 'user', note } } })
      case 'claim':
        return this.#transition(previous, { action, to: 'working', by, at, note, patch: { agent: { at, by }, question: null } })
      case 'ask': {
        const question = requireText(input.question, 'question', this.maxDetailLength)
        return this.#transition(previous, { action, to: 'blocked', by, at, note: note ?? question, patch: { question } })
      }
      case 'answer': {
        const text = requireText(input.text, 'text', this.maxDetailLength)
        const answers = [...previous.answers, { at, by, text }]
        const detail = previous.detail.length === 0 ? text : `${previous.detail}\n\n${text}`
        return this.#transition(previous, {
          action, to: 'working', by, at, note: note ?? preview(text, 120),
          patch: { answers, detail, question: null },
        })
      }
      case 'submit': {
        const summary = requireText(input.summary, 'summary', this.maxDetailLength)
        const evidence = optionalText(input.evidence, 'evidence', this.maxDetailLength)
        return this.#transition(previous, {
          action, to: 'review', by, at, note: note ?? preview(summary, 120),
          patch: { submission: { at, by, summary, evidence }, question: null },
        })
      }
      case 'confirm':
        // The confirmation is the completion: `review` → `done` in one step, with
        // the user's approval and completion recorded together.
        return this.#transition(previous, {
          action, to: 'done', by, at, note,
          patch: {
            completion: { at, by, note },
            approval: { at, by: 'user', note },
            accepted: previous.accepted ?? { at, by: 'user', note: 'the user confirmed the result' },
            question: null,
          },
        })
      case 'complete':
        return this.#transition(previous, {
          action, to: 'done', by, at, note,
          patch: {
            completion: { at, by, note },
            // The user's own completion is the confirmation; the model consumes one.
            approval: previous.approval ?? { at, by: 'user', note: note ?? 'the user marked it done' },
            accepted: previous.accepted ?? { at, by: 'user', note: 'the user marked it done' },
            question: null,
          },
        })
      case 'reopen':
        return this.#transition(previous, {
          action, to: 'open', by, at, note,
          patch: { completion: null, approval: null, voided: null, question: null },
        })
      case 'void':
        return this.#void(previous, by, at, optionalText(input.reason, 'reason', this.maxDetailLength) || note || (by === 'ai' ? null : '用户作废'), 'void')
      case 'update': {
        const patch = {}
        if (input.title !== undefined) patch.title = requireText(input.title, 'title', this.maxTitleLength)
        if (input.detail !== undefined) patch.detail = optionalText(input.detail, 'detail', this.maxDetailLength)
        if (input.acceptance !== undefined) patch.acceptance = optionalText(input.acceptance, 'acceptance', this.maxDetailLength)
        if (input.tags !== undefined) patch.tags = normalizeTags(input.tags)
        if (input.priority !== undefined) patch.priority = normalizePriority(input.priority)
        if (Object.keys(patch).length === 0) throw new TodoError('update needs at least one of title, detail, acceptance, tags, priority')
        return this.#transition(previous, {
          action, to: previous.status, by, at, note,
          patch: { ...patch, editedAt: at },
        })
      }
      default:
        throw new TodoError(`unknown action ${JSON.stringify(action)}`)
    }
  }

  /**
   * Apply a void, requiring a reason from the model.
   * @param {Record<string, unknown>} previous - the todo before the action.
   * @param {'ai' | 'user' | 'system'} by - who is acting.
   * @param {string} at - ISO timestamp.
   * @param {string | null} reason - why it was voided.
   * @param {string} action - the action name recorded in history (`void` or `reject`).
   * @returns {Record<string, unknown>} the voided todo.
   * @throws {TodoError} when the model voids without a reason.
   */
  #void(previous, by, at, reason, action) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new TodoError('void requires a non-blank `reason` so the user can see why the todo was cancelled')
    }
    return this.#transition(previous, {
      action, to: 'void', by, at, note: reason,
      patch: { voided: { at, by, reason }, question: null },
    })
  }

  /**
   * Build the next version of a todo: status, patch, history entry, timestamp.
   * @param {Record<string, unknown>} previous - the todo before the action.
   * @param {object} change - the change.
   * @param {string} change.action - action name recorded in history.
   * @param {string} change.to - the new status.
   * @param {'ai' | 'user' | 'system'} change.by - who is acting.
   * @param {string} change.at - ISO timestamp.
   * @param {string | null} change.note - history note.
   * @param {Record<string, unknown>} [change.patch] - extra fields to set.
   * @returns {Record<string, unknown>} the next todo.
   */
  #transition(previous, { action, to, by, at, note, patch = {} }) {
    return {
      ...previous,
      ...patch,
      status: to,
      updatedAt: at,
      history: appendHistory(previous.history, { at, by, action, from: previous.status, to, note }, this.maxHistory),
    }
  }

  /**
   * Run one mutation under the file lock: read, apply, atomically rewrite, prune.
   * @param {'global' | 'project'} scope - level to mutate.
   * @param {(todos: Array<Record<string, unknown>>) => { todos: Array<Record<string, unknown>>, result: Record<string, unknown> }} operation - the mutation.
   * @returns {Promise<Record<string, unknown>>} the operation result plus file/total/pruned/scope.
   */
  async #mutate(scope, operation) {
    const file = this.fileFor(scope)
    return withFileLock(file, async () => {
      const todos = await this.#read(scope)
      const { todos: next, result } = operation(todos)
      await this.#rewrite(scope, next)
      const pruned = await this.#prune(scope)
      const total = next.length - pruned
      return { ...result, file, total, pruned, scope }
    })
  }

  /**
   * Atomically rewrite one level's todo file.
   * @param {'global' | 'project'} scope - level to write.
   * @param {Array<Record<string, unknown>>} todos - the complete todo list, in file order.
   * @returns {Promise<string>} the written file path.
   */
  async #rewrite(scope, todos) {
    const file = this.fileFor(scope)
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    await writeFile(temporary, todos.map((todo) => `${JSON.stringify(todo)}\n`).join(''), 'utf8')
    await rename(temporary, file)
    return file
  }

  /**
   * Enforce the per-file cap. Finished todos are dropped from the oldest end
   * first, so a long-lived list never loses work that is still open.
   * @param {'global' | 'project'} scope - level to prune.
   * @returns {Promise<number>} the number of pruned todos.
   */
  async #prune(scope) {
    if (this.maxTodos <= 0) return 0
    const todos = await this.#read(scope)
    if (todos.length <= this.maxTodos) return 0
    let excess = todos.length - this.maxTodos
    const removed = new Set()
    for (let index = 0; index < todos.length && excess > 0; index += 1) {
      if (TERMINAL_STATUSES.includes(todos[index].status)) {
        removed.add(index)
        excess -= 1
      }
    }
    for (let index = 0; index < todos.length && excess > 0; index += 1) {
      if (!removed.has(index)) {
        removed.add(index)
        excess -= 1
      }
    }
    const kept = todos.filter((_todo, index) => !removed.has(index))
    await this.#rewrite(scope, kept)
    return removed.size
  }

  /**
   * Read one level's todos in file order (oldest first).
   * @param {'global' | 'project'} scope - level to read.
   * @returns {Promise<Array<Record<string, unknown>>>} parsed todos.
   */
  async #read(scope) {
    const file = this.fileFor(scope)
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (isAbsent(error)) return []
      throw error
    }
    const todos = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let parsed
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }
      const todo = toTodo(parsed, scope)
      if (todo !== undefined) todos.push(todo)
    }
    return todos
  }

  /**
   * Find one todo inside one level.
   * @param {'global' | 'project'} scope - level to search.
   * @param {string} id - todo id.
   * @returns {Promise<Record<string, unknown> | undefined>} the todo, or undefined.
   */
  async #find(scope, id) {
    return (await this.#read(scope)).find((todo) => todo.id === id)
  }

  /**
   * Mint a short, readable, collision-resistant todo id.
   * @param {'global' | 'project'} scope - level the todo lands in.
   * @returns {string} the new id, for example `p-lx9c2k-01ab3f`.
   */
  #nextId(scope) {
    this.sequence += 1
    const time = Date.now().toString(36)
    const sequence = this.sequence.toString(36).padStart(2, '0')
    const random = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
    return `${scope === 'global' ? 'g' : 'p'}-${time}-${sequence}${random}`
  }
}

/**
 * Order todos for a listing: what needs a human first, then priority, then the
 * most recently touched.
 * @param {Record<string, unknown>} left - one todo.
 * @param {Record<string, unknown>} right - another todo.
 * @returns {number} the comparison.
 */
export function compareTodos(left, right) {
  const rank = (STATUS_RANK[left.status] ?? 99) - (STATUS_RANK[right.status] ?? 99)
  if (rank !== 0) return rank
  const priority = (PRIORITY_RANK[left.priority] ?? 9) - (PRIORITY_RANK[right.priority] ?? 9)
  if (priority !== 0) return priority
  const leftAt = String(left.updatedAt || left.at)
  const rightAt = String(right.updatedAt || right.at)
  return leftAt === rightAt ? 0 : leftAt < rightAt ? 1 : -1
}

/**
 * Project one todo onto the compact shape a list row needs — full detail would
 * make a 2000-todo listing unusable.
 * @param {Record<string, unknown>} todo - the todo.
 * @param {number} [previewLength] - preview cap in characters.
 * @returns {Record<string, unknown>} the summary.
 */
export function summarize(todo, previewLength = 200) {
  return {
    id: todo.id,
    scope: todo.scope,
    title: todo.title,
    status: todo.status,
    priority: todo.priority,
    tags: todo.tags,
    origin: todo.origin,
    at: todo.at,
    updatedAt: todo.updatedAt,
    editedAt: todo.editedAt ?? null,
    preview: preview(todo.detail, previewLength),
    acceptance: preview(todo.acceptance, previewLength),
    question: todo.question ?? null,
    answerCount: Array.isArray(todo.answers) ? todo.answers.length : 0,
    submission: todo.submission === null || todo.submission === undefined
      ? null
      : { at: todo.submission.at, by: todo.submission.by, summary: preview(todo.submission.summary, previewLength) },
    accepted: todo.accepted ?? null,
    approval: todo.approval ?? null,
    completion: todo.completion ?? null,
    voided: todo.voided ?? null,
    actions: availableActions(todo.status, 'user'),
  }
}
