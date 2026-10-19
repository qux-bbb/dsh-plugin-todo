/**
 * `todo` — a DeepSeek Harness plugin for a *user-confirmed* todo list.
 *
 * The model can propose work, but it cannot decide that the work is real or
 * finished on its own:
 *
 * - `todo_propose` adds todos in `proposed`: the user accepts them in the panel.
 * - `todo_claim` starts one, `todo_update` records questions and answers when
 *   the todo does not carry enough information yet, `todo_submit` reports the
 *   result as `review`.
 * - `todo_complete` only works once the user confirmed the result (`confirmed`),
 *   so nothing ever reaches `done` without a recorded user confirmation. The
 *   user can also mark a todo done directly in the panel — that action *is* the
 *   confirmation.
 * - `todo_void` cancels a todo with a reason, and `todo_update`/`todo_list`/
 *   `todo_get` read the list back.
 *
 * Todos live in one of two levels, selected by the `level` / `defaultScope`
 * config and overridable per call:
 *
 * - `global`  → `<dshHome>/todo/todos.jsonl`, shared by every project.
 * - `project` → `<projectRoot>/.dsh/todo/todos.jsonl`, one file per project.
 *
 * The same files back a GUI panel (browser half in `./client.js`) served by this
 * module's HTTP route under `/api/todo`.
 *
 * @module dsh-plugin-todo
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { API_PREFIX, ApiError, CLIENT_HEADER, MAX_BODY_BYTES, createTodoApi } from './api.js'
import {
  DEFAULT_FILE_NAME,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_DETAIL_LENGTH,
  DEFAULT_MAX_HISTORY,
  DEFAULT_MAX_TITLE_LENGTH,
  DEFAULT_MAX_TODOS,
  DEFAULT_PROJECT_MARKERS,
  LEVELS,
  PRIORITIES,
  SCOPES,
  STATUSES,
  TodoError,
  TodoStore,
  availableActions,
  findProjectRoot,
  needsAttention,
  normalizeLevel,
  preview,
  summarize,
} from './store.js'

/** Loader entry name. */
export const name = 'todo'
/** Required services: the tool registry (the command and web registries are optional). */
export const inject = ['tools']

const LEVEL_SCHEMA = z.union([z.const('global'), z.const('project'), z.const('both')])
const SCOPE_SCHEMA = z.union([z.const('global'), z.const('project')])
const STATUS_SCHEMA = z.union(STATUSES.map((status) => z.const(status)))
const PRIORITY_SCHEMA = z.union(PRIORITIES.map((priority) => z.const(priority)))

/**
 * Deployment configuration.
 *
 * `level` chooses which levels exist here and `defaultScope` chooses where an
 * omitted scope lands, so one config shape covers both supported deployments:
 * a global list (`level: global`), a per-project list (`level: project`), or
 * both at once (`level: both`).
 */
export const Config = z.object({
  level: LEVEL_SCHEMA.default('both').description('Todo levels this deployment exposes: `global` ($DSH_HOME), `project` (per project root), or `both`.'),
  defaultScope: SCOPE_SCHEMA.default('project').description('Level used when a call omits `scope`.'),
  dshHome: z.string().default('').description('Harness home for the global level; empty resolves $DSH_HOME, then ~/.dsh.'),
  globalDir: z.string().default('').description('Global todo directory; empty uses `<dshHome>/todo`.'),
  projectDir: z.string().default('').description('Project todo directory; empty uses `<projectRoot>/.dsh/todo`.'),
  fileName: z.string().default(DEFAULT_FILE_NAME).description('Todo file name inside a level directory.'),
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_MARKERS]).description('Ancestor markers that identify a project root, nearest first.'),
  maxTodos: z.natural().default(DEFAULT_MAX_TODOS).description('Todos kept per file; finished ones are pruned first. 0 disables pruning.'),
  maxTitleLength: z.natural().default(DEFAULT_MAX_TITLE_LENGTH).description('Maximum characters in a todo title.'),
  maxDetailLength: z.natural().default(DEFAULT_MAX_DETAIL_LENGTH).description('Maximum characters in a todo detail or acceptance criteria.'),
  maxHistory: z.natural().default(DEFAULT_MAX_HISTORY).description('History entries kept per todo; 0 keeps all.'),
  defaultLimit: z.natural().default(DEFAULT_LIST_LIMIT).description('Todos returned by a listing that omits `limit`.'),
  toolPrefix: z.string().default('todo').description('Prefix of the registered tool names.'),
  enableCommand: z.boolean().default(true).description('Whether to register the human `/todo` command when a command registry is present.'),
  deliverRequests: z.boolean().default(true).description('Whether the panel may hand a todo to the model by delivering a user-role message into the current session.'),
})

/**
 * Resolve raw config into the effective options, applying the same defaults the
 * Config schema would. `apply` stays correct when it is called with a plain
 * object (tests, `cordis:` builtins) instead of loader-validated config.
 * @param {Record<string, unknown>} [config] - raw plugin config.
 * @returns {{ level: 'global' | 'project' | 'both', defaultScope: 'global' | 'project', dshHome: string, globalDir: string, projectDir: string, fileName: string, projectRootMarkers: string[], maxTodos: number, maxTitleLength: number, maxDetailLength: number, maxHistory: number, defaultLimit: number, toolPrefix: string, enableCommand: boolean, deliverRequests: boolean }} effective options.
 */
export function resolveOptions(config = {}) {
  const raw = typeof config === 'object' && config !== null ? config : {}
  const text = (value, fallback) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback)
  const count = (value, fallback) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback)
  // An explicit empty list is meaningful: "the session directory is the project root".
  // Markers are trimmed here as well as in `findProjectRoot`: a configured
  // `' .git '` must not silently resolve a project under a repository to the
  // session directory (and file its todos beside the global ones).
  const markers = Array.isArray(raw.projectRootMarkers)
    ? raw.projectRootMarkers.map((marker) => (typeof marker === 'string' ? marker.trim() : '')).filter((marker) => marker.length > 0)
    : [...DEFAULT_PROJECT_MARKERS]
  const prefix = text(raw.toolPrefix, 'todo')
  return {
    level: normalizeLevel(raw.level),
    defaultScope: SCOPES.includes(raw.defaultScope) ? raw.defaultScope : 'project',
    dshHome: text(raw.dshHome, ''),
    globalDir: text(raw.globalDir, ''),
    projectDir: text(raw.projectDir, ''),
    fileName: text(raw.fileName, DEFAULT_FILE_NAME),
    projectRootMarkers: markers,
    maxTodos: count(raw.maxTodos, DEFAULT_MAX_TODOS),
    maxTitleLength: count(raw.maxTitleLength, DEFAULT_MAX_TITLE_LENGTH),
    maxDetailLength: count(raw.maxDetailLength, DEFAULT_MAX_DETAIL_LENGTH),
    maxHistory: count(raw.maxHistory, DEFAULT_MAX_HISTORY),
    defaultLimit: count(raw.defaultLimit, DEFAULT_LIST_LIMIT),
    toolPrefix: /^[a-z][a-z0-9_-]*$/.test(prefix) ? prefix : 'todo',
    enableCommand: raw.enableCommand !== false,
    deliverRequests: raw.deliverRequests !== false,
  }
}

/**
 * The session working directory a call belongs to, falling back to the host
 * process directory for a non-agent caller.
 * @param {{ agent?: { session?: { header?: { cwd?: string } } } } | undefined} exec - tool execution context.
 * @returns {string} an absolute working directory.
 */
function cwdOf(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

/** The `enabled` clause appended to guidance about a disabled level. */
function scopeHint(options) {
  return options.level === 'both'
    ? 'Use `global` for cross-project todos or `project` for this project\'s todos.'
    : `This deployment stores todos at the \`${options.level}\` level only.`
}

/**
 * The one-line rendering shared by every tool that returns a listing.
 * @param {Array<Record<string, unknown>>} todos - todos, in listing order.
 * @param {number} total - total matching todos before the limit.
 * @returns {string} the rendered listing.
 */
export function renderTodos(todos, total) {
  if (todos.length === 0) return 'No todos match.'
  const head = todos.map((todo, index) => {
    const flags = [
      todo.status,
      todo.priority === 'normal' ? null : todo.priority,
      todo.origin === 'ai' ? 'by model' : null,
    ].filter(Boolean).join(', ')
    const question = todo.question ? ` | waiting for the user: ${todo.question}` : ''
    return `${index + 1}. [${todo.id}] (${flags}) ${todo.title}${question}`
  })
  const tail = todos.length < total ? `\n… ${total - todos.length} more todo(s) not shown.` : ''
  return `${head.join('\n')}${tail}`
}

/**
 * The workflow reminder attached to `todo_claim`: the model must decide whether
 * it actually knows enough to finish the todo before touching any files.
 * @param {Record<string, unknown>} todo - the claimed todo.
 * @param {string} [prefix] - the configured tool prefix.
 * @returns {string} the reminder.
 */
export function renderClaim(todo, prefix = 'todo') {
  const lines = [
    `Claimed ${todo.id} — "${todo.title}" is now \`working\`.`,
    '',
    `Detail: ${todo.detail.length > 0 ? todo.detail : '(none)'}`,
    `Acceptance criteria: ${todo.acceptance.length > 0 ? todo.acceptance : '(none — confirm what "done" means with the user before you start)'}`,
  ]
  if (Array.isArray(todo.answers) && todo.answers.length > 0) {
    lines.push('Answers already on record:')
    for (const answer of todo.answers) lines.push(`- ${answer.text}`)
  }
  lines.push(
    '',
    'Before doing the work, decide whether this todo carries enough information to finish it correctly.',
    'If it does not, ask the user — either in the conversation, or by recording the missing information with',
    `\`${prefix}_update\`(id="${todo.id}", question="..."): the user answers in the todo panel and \`${prefix}_get\` shows it back.`,
    `When the todo is done, call \`${prefix}_submit\`(id="${todo.id}", summary="..."). You cannot mark it done: the user confirms first.`,
  )
  return lines.join('\n')
}

/**
 * Register the todo tools, the `/todo` command, and the panel's HTTP route on
 * the calling context.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context. `ctx.tools` is required; `ctx.commands` and `webServer` are used when present.
 * @param {Record<string, unknown>} [config] - raw plugin config.
 */
export function apply(ctx, config = {}) {
  const options = resolveOptions(config)
  /** @type {Map<string, TodoStore>} per-working-directory stores. */
  const stores = new Map()
  const storeFor = (cwd) => {
    let store = stores.get(cwd)
    if (store === undefined) {
      if (stores.size >= 32) stores.clear()
      store = new TodoStore({ cwd, ...options })
      stores.set(cwd, store)
    }
    return store
  }
  const tool = (suffix) => `${options.toolPrefix}_${suffix}`

  ctx.tools.register(defineTool({
    name: tool('propose'),
    description: `Propose one or more todos for the user's todo list. ${scopeHint(options)} Proposed todos enter the \`proposed\` status: they are NOT real todos until the user accepts each one in the todo panel. Never claim that a proposed todo is accepted — say that it needs the user's confirmation.`,
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The todos to propose. One entry per concrete unit of work.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: 'Short, imperative one-line title.' },
            detail: { type: 'string', description: 'What has to happen, with any context the user did not have to repeat.' },
            acceptance: { type: 'string', description: 'How the user can tell it is done. Fill this in: it is what the user confirms later.' },
            priority: { type: 'string', enum: [...PRIORITIES], description: 'Defaults to `normal`.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional free-form tags.' },
          },
        },
      },
      scope: { type: 'string', enum: [...SCOPES], description: 'Storage level; omitted uses the configured default level.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true },
          file: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          created: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true },
                priority: { type: 'string', required: true },
                scope: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Proposed ${value.created.length} todo(s) in the ${value.scope} list — all \`proposed\`, waiting for the user to accept them in the todo panel:`,
          ...value.created.map((todo, index) => `${index + 1}. [${todo.id}] (${todo.priority}) ${todo.title}`),
          `File: ${value.file} (${value.total} todo(s) there)`,
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const store = storeFor(cwdOf(exec))
      const added = await store.create({ items: args.todos, scope: args.scope, origin: 'ai' })
      return {
        scope: added.scope,
        file: added.file,
        total: added.total,
        created: added.todos.map((todo) => ({
          id: todo.id,
          title: todo.title,
          status: todo.status,
          priority: todo.priority,
          scope: todo.scope,
        })),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Todo: propose ${Array.isArray(args.todos) ? args.todos.length : 0} item(s)`,
      kind: 'other',
      rawInput: Array.isArray(args.todos) ? args.todos.map((item) => item?.title).filter(Boolean).join('\n') : args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: tool('list'),
    description: `Read the todo list back. ${scopeHint(options)} Omit \`scope\` to read every enabled level. Filter with \`status\` (\`all\` by default, or one of ${STATUSES.join(', ')}) and \`query\`; \`limit\` bounds the result (0 returns every match). Todos needing a human decision — \`proposed\` (waiting to be accepted), \`review\` (waiting to be confirmed) and \`blocked\` (waiting for an answer) — are listed first.`,
    parameters: {
      scope: { type: 'string', enum: [...SCOPES], description: 'Level to read; omitted reads every enabled level.' },
      status: { type: 'string', enum: [...STATUSES, 'all'], description: 'Status filter; `all` (the default) returns every status.' },
      query: { type: 'string', description: 'Case-insensitive substring filter over title, detail, tags, and id.' },
      limit: { type: 'integer', description: `Maximum todos to return; 0 returns every match. Defaults to ${options.defaultLimit}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scopes: { type: 'array', required: true, items: { type: 'string' } },
          total: { type: 'integer', required: true },
          returned: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true },
                priority: { type: 'string', required: true },
                origin: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                at: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                question: { type: 'string' },
                summary: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${renderTodos(value.todos, value.total)}\nLevels: ${value.scopes.join(' + ')}`,
      }],
    },
    async execute(args, exec) {
      const listing = await storeFor(cwdOf(exec)).list({ scope: args.scope, status: args.status, query: args.query, limit: args.limit })
      return {
        scopes: listing.scopes,
        total: listing.total,
        returned: listing.returned,
        truncated: listing.truncated,
        todos: listing.todos.map((todo) => {
          const summary = summarize(todo, 160)
          return {
            id: summary.id,
            title: summary.title,
            status: summary.status,
            priority: summary.priority,
            origin: summary.origin,
            scope: summary.scope,
            at: summary.at,
            updatedAt: summary.updatedAt,
            tags: summary.tags,
            ...(summary.question === null ? {} : { question: summary.question }),
            ...(summary.submission === null ? {} : { summary: summary.submission.summary }),
          }
        }),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Todo: list', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: tool('get'),
    description: `Read one todo in full: detail, acceptance criteria, the answers the user gave, the submitted result, the recorded user confirmation, and the transition history. Use this before working on a todo. ${scopeHint(options)}`,
    parameters: {
      id: { type: 'string', required: true, description: 'Todo id, as returned by the other todo tools.' },
      scope: { type: 'string', enum: [...SCOPES], description: 'Level holding the todo; omitted locates it by id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          title: { type: 'string', required: true },
          detail: { type: 'string', required: true },
          acceptance: { type: 'string', required: true },
          status: { type: 'string', required: true },
          priority: { type: 'string', required: true },
          origin: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          at: { type: 'string', required: true },
          updatedAt: { type: 'string', required: true },
          question: { type: 'string' },
          answers: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          submission: { type: 'object', additionalProperties: true },
          accepted: { type: 'object', additionalProperties: true },
          approval: { type: 'object', additionalProperties: true },
          completion: { type: 'object', additionalProperties: true },
          voided: { type: 'object', additionalProperties: true },
          history: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          availableActions: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `[${value.id}] ${value.title}`,
          `Status: ${value.status} | priority: ${value.priority} | level: ${value.scope} | origin: ${value.origin}`,
          `Detail: ${value.detail.length > 0 ? value.detail : '(none)'}`,
          `Acceptance criteria: ${value.acceptance.length > 0 ? value.acceptance : '(none)'}`,
          value.question ? `Waiting for the user: ${value.question}` : null,
          value.answers.length > 0 ? `Answers:\n${value.answers.map((answer) => `- ${answer.text}`).join('\n')}` : null,
          value.submission ? `Submitted: ${value.submission.summary}` : null,
          value.approval ? `User confirmation: ${value.approval.at}` : null,
          value.completion ? `Completed: ${value.completion.at} by ${value.completion.by}` : null,
          value.voided ? `Voided: ${value.voided.reason}` : null,
          `Actions available to you: ${value.availableActions.join(', ') || '(none — this todo is waiting on the user)'}`,
          `History (${value.history.length}):\n${value.history.map((entry) => `- ${entry.at} ${entry.by}/${entry.action}: ${entry.from ?? '∅'} → ${entry.to}${entry.note ? ` (${entry.note})` : ''}`).join('\n')}`,
        ].filter((line) => line !== null).join('\n'),
      }],
    },
    async execute(args, exec) {
      const store = storeFor(cwdOf(exec))
      const located = await store.locate({ id: args.id, scope: args.scope })
      if (located.todo === undefined) throw new TodoError(`no todo ${JSON.stringify(args.id)} in the ${store.scopes.join(' + ')} level`)
      const todo = located.todo
      return {
        id: todo.id,
        scope: todo.scope,
        title: todo.title,
        detail: todo.detail,
        acceptance: todo.acceptance,
        status: todo.status,
        priority: todo.priority,
        origin: todo.origin,
        tags: todo.tags,
        at: todo.at,
        updatedAt: todo.updatedAt,
        ...(todo.question === null ? {} : { question: todo.question }),
        answers: todo.answers,
        ...(todo.submission === null ? {} : { submission: todo.submission }),
        ...(todo.accepted === null ? {} : { accepted: todo.accepted }),
        ...(todo.approval === null ? {} : { approval: todo.approval }),
        ...(todo.completion === null ? {} : { completion: todo.completion }),
        ...(todo.voided === null ? {} : { voided: todo.voided }),
        history: todo.history,
        availableActions: availableActions(todo.status, 'ai'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Todo: read', kind: 'read', rawInput: args.id }),
  }))

  ctx.tools.register(defineTool({
    name: tool('claim'),
    description: 'Start one todo: marks it `working` and returns everything you must check before doing the work. Claim only when the user asked you to do this todo. Then decide whether the todo carries enough information to finish it — if not, gather it from the user (in the conversation, or with a recorded question) before you start.',
    parameters: {
      id: { type: 'string', required: true, description: 'Todo id.' },
      scope: { type: 'string', enum: [...SCOPES], description: 'Level holding the todo; omitted locates it by id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true },
          detail: { type: 'string', required: true },
          acceptance: { type: 'string', required: true },
          priority: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          question: { type: 'string' },
          answers: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderClaim(value, options.toolPrefix) }],
    },
    async execute(args, exec) {
      const store = storeFor(cwdOf(exec))
      const result = await store.act({ id: args.id, scope: args.scope, action: 'claim', actor: 'ai' })
      const todo = result.todo
      return {
        id: todo.id,
        title: todo.title,
        status: todo.status,
        detail: todo.detail,
        acceptance: todo.acceptance,
        priority: todo.priority,
        scope: todo.scope,
        ...(todo.question === null ? {} : { question: todo.question }),
        answers: todo.answers,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Todo: start', kind: 'other', rawInput: args.id }),
  }))

  ctx.tools.register(defineTool({
    name: tool('update'),
    description: 'Edit one todo, and record the information exchange with the user. Pass any of title/detail/acceptance/tags/priority to fix the todo text. Pass `question` when the todo lacks information you need: it moves the todo to `blocked` and asks the user in the todo panel. Pass `answer` when the user told you the missing information (in the conversation or in the panel): it is appended to the todo and the todo returns to `working`.',
    parameters: {
      id: { type: 'string', required: true, description: 'Todo id.' },
      scope: { type: 'string', enum: [...SCOPES], description: 'Level holding the todo; omitted locates it by id.' },
      title: { type: 'string', description: 'Replacement title.' },
      detail: { type: 'string', description: 'Replacement detail. Pass the full text, not a diff.' },
      acceptance: { type: 'string', description: 'Replacement acceptance criteria.' },
      priority: { type: 'string', enum: [...PRIORITIES], description: 'Replacement priority.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tags (the full list).' },
      question: { type: 'string', description: 'The information you need from the user; moves the todo to `blocked`.' },
      answer: { type: 'string', description: 'Information the user just gave you; appended to the todo, which returns to `working`.' },
      note: { type: 'string', description: 'Optional note recorded in the todo history.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          title: { type: 'string', required: true },
          edited: { type: 'array', required: true, items: { type: 'string' } },
          question: { type: 'string' },
          answers: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Updated ${value.id} — "${value.title}" is now \`${value.status}\`.`,
          value.edited.length > 0 ? `Changed: ${value.edited.join(', ')}` : 'No fields changed.',
          value.question ? `Waiting for the user to answer: ${value.question}` : null,
          value.answers.length > 0 ? `Answers on record: ${value.answers.length}` : null,
        ].filter((line) => line !== null).join('\n'),
      }],
    },
    async execute(args, exec) {
      const store = storeFor(cwdOf(exec))
      const fields = ['title', 'detail', 'acceptance', 'tags', 'priority']
      const changed = fields.filter((field) => args[field] !== undefined)
      if (changed.length === 0 && args.question === undefined && args.answer === undefined) {
        throw new TodoError('todo_update needs at least one of title, detail, acceptance, tags, priority, question, answer')
      }
      if (changed.length > 0) {
        await store.act({
          id: args.id, scope: args.scope, action: 'update', actor: 'ai', note: args.note,
          ...Object.fromEntries(changed.map((field) => [field, args[field]])),
        })
      }
      if (args.question !== undefined) {
        await store.act({ id: args.id, scope: args.scope, action: 'ask', actor: 'ai', question: args.question, note: args.note })
      }
      if (args.answer !== undefined) {
        await store.act({ id: args.id, scope: args.scope, action: 'answer', actor: 'ai', text: args.answer, note: args.note })
      }
      const todo = await store.get({ id: args.id, scope: args.scope })
      if (todo === undefined) throw new TodoError(`no todo ${JSON.stringify(args.id)}`)
      return {
        id: todo.id,
        status: todo.status,
        title: todo.title,
        edited: changed,
        ...(todo.question === null ? {} : { question: todo.question }),
        answers: todo.answers,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Todo: edit', kind: 'other', rawInput: args.id }),
  }))

  ctx.tools.register(defineTool({
    name: tool('submit'),
    description: 'Report that you finished a todo: moves it to `review` and asks the user to confirm the result. You still cannot mark it done — after the user confirms (`confirmed`) call `todo_complete`. Tell the user what you did and that the todo is waiting for their confirmation.',
    parameters: {
      id: { type: 'string', required: true, description: 'Todo id.' },
      scope: { type: 'string', enum: [...SCOPES], description: 'Level holding the todo; omitted locates it by id.' },
      summary: { type: 'string', required: true, description: 'What you actually did, in the user\'s terms. The user confirms this text.' },
      evidence: { type: 'string', description: 'Optional concrete evidence: files changed, commands run, tests passed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          title: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Submitted ${value.id} — "${value.title}" is now \`review\`.\nWhat you reported: ${value.summary}\nThe todo is waiting for the user's confirmation in the todo panel. Do not mark it done; after the user confirms, call \`${'todo_complete'}\` with this id.`,
      }],
    },
    async execute(args, exec) {
      const result = await storeFor(cwdOf(exec)).act({
        id: args.id, scope: args.scope, action: 'submit', actor: 'ai',
        summary: args.summary, evidence: args.evidence,
      })
      return { id: result.todo.id, status: result.todo.status, title: result.todo.title, summary: result.todo.submission.summary }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Todo: submit for confirmation', kind: 'other', rawInput: args.id }),
  }))

  ctx.tools.register(defineTool({
    name: tool('complete'),
    description: 'Mark one todo `done`. This only works when the user already confirmed the submitted result (status `confirmed`); a todo in any other status is refused, because completing one always requires the user\'s confirmation. Check the status with `todo_get` before calling it, and only call it for the todo the user just confirmed.',
    parameters: {
      id: { type: 'string', required: true, description: 'Todo id.' },
      scope: { type: 'string', enum: [...SCOPES], description: 'Level holding the todo; omitted locates it by id.' },
      note: { type: 'string', description: 'Optional closing note recorded in the todo history.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          title: { type: 'string', required: true },
          approvedAt: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Marked ${value.id} — "${value.title}" as \`done\` (the user confirmed it${value.approvedAt ? ` at ${value.approvedAt}` : ''}).`,
      }],
    },
    async execute(args, exec) {
      const result = await storeFor(cwdOf(exec)).act({ id: args.id, scope: args.scope, action: 'complete', actor: 'ai', note: args.note })
      const todo = result.todo
      return {
        id: todo.id,
        status: todo.status,
        title: todo.title,
        ...(todo.approval === null ? {} : { approvedAt: todo.approval.at }),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Todo: mark done', kind: 'other', rawInput: args.id }),
  }))

  ctx.tools.register(defineTool({
    name: tool('void'),
    description: `Cancel one todo: it moves to \`void\` and stays in the list for the record. Use it for a todo that should not happen, and always give a reason. Destructive: pass \`confirm: true\`. ${scopeHint(options)}`,
    parameters: {
      id: { type: 'string', required: true, description: 'Todo id.' },
      reason: { type: 'string', required: true, description: 'Why this todo should not be done.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true; the call is refused otherwise.' },
      scope: { type: 'string', enum: [...SCOPES], description: 'Level holding the todo; omitted locates it by id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          title: { type: 'string', required: true },
          reason: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Voided ${value.id} — "${value.title}": ${value.reason}`,
      }],
    },
    async execute(args, exec) {
      if (args.confirm !== true) throw new TodoError('refusing to void a todo: pass `confirm: true` to confirm the cancellation')
      const result = await storeFor(cwdOf(exec)).act({ id: args.id, scope: args.scope, action: 'void', actor: 'ai', reason: args.reason })
      return { id: result.todo.id, status: result.todo.status, title: result.todo.title, reason: result.todo.voided.reason }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Todo: cancel', kind: 'delete', rawInput: args.id }),
  }))

  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : ctx.commands
  if (options.enableCommand && commands !== undefined && typeof commands.register === 'function') {
    ctx.effect(() => commands.register({
      name: 'todo',
      description: 'Show the todo list, or add / finish / inspect one todo',
      input: { hint: '[add <title> | done <id> | show <id>] — 留空则列出待办' },
      handler: async (invocation) => {
        const store = storeFor(invocation.agent?.session?.header?.cwd ?? process.cwd())
        return handleTodoCommand(store, typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : '')
      },
    }), 'todo /todo command')
  }

  // The panel's data channel. `webServer` is optional: a profile without a Web
  // carrier (headless, sdk) keeps the tools and the `/todo` command only.
  const api = createTodoApi({
    storeFor,
    listProjects: () => listProjects(ctx),
    // The panel follows the session the user is in: its session-scoped client
    // registration reports the id, and the host resolves that session's cwd to
    // the same project the model tools use.
    resolveSessionCwd: (sessionId) => {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      if (agents === undefined || typeof agents.get !== 'function') return undefined
      try {
        return agents.get(sessionId)?.session?.header?.cwd
      } catch {
        return undefined
      }
    },
    // "Let the model do it": deliver a user-role message into the chosen session.
    // `listSessions`/`createSession` back the panel's target picker.
    listSessions: (input) => listSessions(ctx, options, input),
    createSession: (input) => createSession(ctx, input),
    deliverRequest: options.deliverRequests ? (input) => deliverToAgent(ctx, input) : undefined,
    // Reuse the host's own browser-session gate: this route shadows the API
    // gateway prefix, so nothing else would authenticate it.
    admit: (request) => {
      const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined
      try {
        return connection.requestRejection({ headers: request.headers })
      } catch {
        return undefined
      }
    },
  })
  ctx.inject(['webServer'], (routeCtx) => {
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => {
        void serveTodoApi(api, req, res, routeCtx.logger)
      },
    }), 'todo api route')
  })
}

/**
 * The host's session business API, when this deployment has one.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @returns {Record<string, Function> | undefined} `ctx.sessionController`.
 */
function sessionControllerOf(ctx) {
  const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : ctx.sessionController
  return controller === undefined || controller === null ? undefined : controller
}

/**
 * The conversations the panel may hand a todo to: every ordinary session the
 * host knows, newest activity first, with the project each one belongs to.
 *
 * Subagent sessions are filtered out — they are not conversations the user can
 * address. `undefined` (not `[]`) reports "this deployment cannot list
 * sessions", which the panel renders as "current session only" instead of an
 * empty picker.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {ReturnType<typeof resolveOptions>} options - effective plugin options.
 * @param {{ limit?: number }} [input] - listing input.
 * @returns {Promise<Array<Record<string, unknown>> | undefined>} the sessions, or undefined without the service.
 */
export async function listSessions(ctx, options, { limit = 25 } = {}) {
  const controller = sessionControllerOf(ctx)
  if (controller === undefined || typeof controller.list !== 'function') return undefined
  let listed
  try {
    listed = await controller.list({}, new AbortController().signal)
  } catch {
    return undefined
  }
  const items = Array.isArray(listed?.items) ? listed.items : []
  const wanted = typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : 25
  return items
    .filter((item) => item !== null && typeof item === 'object')
    .filter((item) => item.origin !== 'subagent')
    .filter((item) => item.parentSessionId === undefined || item.parentSessionId === null)
    .slice(0, wanted)
    .map((item) => {
      // A session id is a branded string; anything else is not an addressable
      // conversation, and handing a todo to it would fail later for no good reason.
      const id = typeof item.sessionId === 'string' ? item.sessionId.trim() : ''
      const cwd = typeof item.cwd === 'string' && item.cwd.length > 0 ? item.cwd : null
      const hint = item.projections?.values?.title
      const title = typeof hint === 'string' && hint.trim().length > 0
        ? hint.trim()
        : cwd === null ? id : basename(cwd) || id
      return {
        id,
        title,
        cwd,
        projectRoot: cwd === null ? null : findProjectRoot(cwd, options.projectRootMarkers),
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
        running: item.running === true,
        agentAvailable: item.agentAvailable === true,
        blank: item.blank === true,
      }
    })
    .filter((session) => session.id.length > 0)
}

/**
 * Create one ordinary session in the given working directory.
 *
 * The session is created through the workspace that owns the directory when the
 * host has one: `sessionController.create` then attaches the new session to
 * that workspace, so the sidebar files it under its project. Creating with a
 * bare `cwd` instead makes the host open the session in the right directory but
 * account it nowhere, which shows up as "未分组". The host accepts `workspaceId`
 * *or* `cwd`, never both; the workspace already carries the canonical path, so
 * naming it is enough.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{ cwd: string }} input - the working directory for the new session.
 * @returns {Promise<{ sessionId: string } | undefined>} the new session, or undefined without the service.
 */
export async function createSession(ctx, { cwd }) {
  const controller = sessionControllerOf(ctx)
  if (controller === undefined || typeof controller.create !== 'function') return undefined
  const workspaceId = await workspaceIdForCwd(ctx, cwd)
  const created = await controller.create(workspaceId === undefined ? { cwd } : { workspaceId })
  const sessionId = created?.sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : undefined
}

/**
 * The registered workspace that owns one directory, when there is one.
 *
 * `workspaceRegistry.resolveByPath` canonicalizes both sides through
 * `fs.realpath` — the same canon the registry stores and compares on — and
 * rejects for a path that does not resolve, so an unresolvable or unowned
 * directory simply reports "no workspace" and the caller keeps using `cwd`.
 * A host without `resolveByPath` still exposes the list projection, which is
 * compared as-is after trimming trailing separators (and folding case on
 * Windows, where paths are case-insensitive).
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {string} cwd - the requested working directory.
 * @returns {Promise<string | undefined>} the workspace id, or undefined when no workspace owns the path.
 */
async function workspaceIdForCwd(ctx, cwd) {
  const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  if (registry === undefined || typeof cwd !== 'string' || cwd.trim().length === 0) return undefined
  try {
    if (typeof registry.resolveByPath === 'function') {
      const workspace = await registry.resolveByPath(cwd)
      return workspaceIdOf(workspace)
    }
    if (typeof registry.list !== 'function') return undefined
    const wanted = comparablePath(cwd)
    const owner = registry.list().find((workspace) => comparablePath(workspace?.path) === wanted)
    return workspaceIdOf(owner)
  } catch {
    return undefined
  }
}

/**
 * One workspace's id, when the record carries a non-empty one.
 * @param {unknown} workspace - a workspace entity from the registry.
 * @returns {string | undefined} the id.
 */
function workspaceIdOf(workspace) {
  const id = workspace === null || workspace === undefined ? undefined : workspace.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * One directory path in the spelling the fallback list comparison uses.
 * @param {unknown} path - a path from the registry or a request.
 * @returns {string} the comparison key (empty for a non-string).
 */
function comparablePath(path) {
  const text = typeof path === 'string' ? path.replace(/[\\/]+$/, '') : ''
  return process.platform === 'win32' ? text.toLowerCase() : text
}

/**
 * Hand one todo to a session as a user-role message, which wakes that session's
 * agent the same way the user typing the request would.
 *
 * The host's `sessionController.prompt()` is preferred: it resolves *and
 * resumes* the addressed session, so the panel can target any conversation from
 * the list, not only the ones that already own a live agent. When that service
 * is absent (headless, SDK) the plugin falls back to delivering straight into a
 * live agent's inbox.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{ sessionId: string, prompt: string }} input - the delivery request.
 * @returns {Promise<{ delivered: boolean, reason?: string, via?: string }>} the outcome.
 */
export async function deliverToAgent(ctx, { sessionId, prompt }) {
  const controller = sessionControllerOf(ctx)
  /** The failure of the preferred path, reported only when no fallback works. */
  let promptError
  if (controller !== undefined && typeof controller.prompt === 'function') {
    try {
      await controller.prompt({
        requestId: `todo-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      })
      return { delivered: true, via: 'prompt' }
    } catch (error) {
      // Resuming a cold session can fail for reasons that do not affect a live
      // agent, so keep the direct-inbox path as a fallback before giving up.
      promptError = error
    }
  }
  const resolved = resolveLiveAgent(ctx, sessionId)
  if (resolved.missing === true) {
    if (promptError !== undefined) return { delivered: false, reason: deliveryFailure(sessionId, promptError) }
    return { delivered: false, reason: 'this host exposes no agent registry, so the request cannot be delivered' }
  }
  if (resolved.error !== undefined) {
    if (promptError !== undefined) return { delivered: false, reason: deliveryFailure(sessionId, promptError) }
    return { delivered: false, reason: `could not resolve session ${sessionId}: ${errorText(resolved.error)}` }
  }
  const agent = resolved.agent
  if (agent === undefined) {
    if (promptError !== undefined) return { delivered: false, reason: deliveryFailure(sessionId, promptError) }
    return { delivered: false, reason: `session ${sessionId} has no live agent: pick another session, open it first, or copy the prompt and send it yourself` }
  }
  if (typeof agent.followup !== 'function') {
    return { delivered: false, reason: 'this agent does not accept follow-up messages' }
  }
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    return { delivered: true, via: 'followup' }
  } catch (error) {
    return { delivered: false, reason: `delivering the request failed: ${errorText(error)}` }
  }
}

/**
 * One error's message.
 * @param {unknown} error - a thrown value.
 * @returns {string} the message.
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Why the preferred delivery path failed.
 * @param {string} sessionId - the session that refused it.
 * @param {unknown} error - the failure.
 * @returns {string} the caller-facing reason.
 */
function deliveryFailure(sessionId, error) {
  return `session ${sessionId} could not accept the request: ${errorText(error)}`
}

/**
 * The live agent of one session, distinguishing "no registry", "the registry
 * itself failed", and "this session has no live agent" — the three cases need
 * different caller-facing messages.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {string} sessionId - session id.
 * @returns {{ agent?: Record<string, unknown>, missing?: true, error?: unknown }} the resolution.
 */
function resolveLiveAgent(ctx, sessionId) {
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (agents === undefined || typeof agents.get !== 'function') return { missing: true }
  try {
    return { agent: agents.get(sessionId) ?? undefined }
  } catch (error) {
    return { error }
  }
}

/**
 * The `/todo` command: list, add, finish, or inspect one todo. Everything the
 * command does is a *user* action, so it may accept a proposal and mark a todo
 * done directly.
 * @param {TodoStore} store - the invoking session's store.
 * @param {string} rawInput - the text after `/todo`.
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>} the command result.
 */
export async function handleTodoCommand(store, rawInput) {
  const [verb, ...rest] = rawInput.split(/\s+/).filter((token) => token.length > 0)
  const argument = rest.join(' ').trim()
  try {
    if (verb === undefined) {
      const listing = await store.list({ limit: 5, status: 'all' })
      const attention = Object.entries(listing.counts)
        .filter(([status, count]) => count > 0 && needsAttention(status))
        .map(([status, count]) => `${count} ${status}`)
      return {
        kind: 'success',
        text: [
          attention.length > 0 ? `Waiting for you: ${attention.join(', ')}` : 'Nothing waiting for you.',
          renderTodos(listing.todos, listing.total),
          '用法：/todo add <标题> · /todo done <id> · /todo show <id>',
        ].join('\n'),
      }
    }
    if (verb === 'add') {
      if (argument.length === 0) return { kind: 'error', text: '用法：/todo add <标题>' }
      const added = await store.create({ items: [{ title: argument }], origin: 'user' })
      return { kind: 'success', text: `Added ${added.todos[0].id}: ${added.todos[0].title}\nFile: ${added.file}` }
    }
    if (verb === 'done') {
      if (argument.length === 0) return { kind: 'error', text: '用法：/todo done <id>' }
      const result = await store.act({ id: argument, action: 'complete', actor: 'user', note: 'marked done from /todo' })
      return { kind: 'success', text: `Marked ${result.todo.id} done: ${result.todo.title}` }
    }
    if (verb === 'show') {
      if (argument.length === 0) return { kind: 'error', text: '用法：/todo show <id>' }
      const todo = await store.get({ id: argument })
      if (todo === undefined) return { kind: 'error', text: `No todo ${argument}.` }
      return {
        kind: 'success',
        text: [
          `[${todo.id}] ${todo.title}`,
          `Status: ${todo.status} (${availableActions(todo.status, 'user').join(', ') || 'no action'})`,
          todo.detail.length > 0 ? `Detail: ${preview(todo.detail, 500)}` : null,
          todo.acceptance.length > 0 ? `Acceptance: ${preview(todo.acceptance, 300)}` : null,
          todo.question ? `Waiting for you: ${todo.question}` : null,
        ].filter((line) => line !== null).join('\n'),
      }
    }
    return { kind: 'error', text: `未知用法 /todo ${verb}。用法：/todo add <标题> · /todo done <id> · /todo show <id>` }
  } catch (error) {
    if (error instanceof TodoError) return { kind: 'error', text: error.message }
    throw error
  }
}

/**
 * The project directories the panel can target: every registered workspace,
 * most recently updated first so the panel's fallback and its dropdown both
 * prefer the project that was touched last.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @returns {Array<{ path: string, title: string }>} registered workspaces.
 */
function listProjects(ctx) {
  const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    return registry.list()
      .map((workspace) => ({ path: workspace.path, title: workspace.title, updatedAt: workspace.updatedAt }))
      .sort((left, right) => (left.updatedAt === right.updatedAt ? 0 : left.updatedAt < right.updatedAt ? 1 : -1))
      .map(({ path, title }) => ({ path, title }))
  } catch {
    return []
  }
}

/**
 * Read a request body, bounded by {@link MAX_BODY_BYTES}.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<string>} the body text.
 * @throws {ApiError} 413 when the body exceeds the cap.
 */
async function readRequestBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new ApiError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 */
function respondJson(res, status, payload) {
  const text = JSON.stringify(payload ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Serve one todo API request over HTTP. The route is same-origin only: it
 * answers no CORS preflight, and the API itself requires {@link CLIENT_HEADER}.
 * @param {ReturnType<typeof createTodoApi>} api - the API.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {{ warn?: (value: unknown) => void }} [logger] - host logger.
 */
async function serveTodoApi(api, req, res, logger) {
  try {
    const method = String(req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) {
      respondJson(res, 404, { error: `unknown todo route ${JSON.stringify(url.pathname)}` })
      return
    }
    const query = Object.fromEntries(url.searchParams.entries())
    let body
    if (method !== 'GET' && method !== 'HEAD') {
      const raw = await readRequestBody(req)
      if (raw.trim().length > 0) {
        try {
          body = JSON.parse(raw)
        } catch {
          respondJson(res, 400, { error: 'request body must be valid JSON' })
          return
        }
      }
    }
    const result = await api.handle({ method, pathname: url.pathname, query, headers: req.headers ?? {}, body })
    respondJson(res, result.status, result.body)
  } catch (error) {
    if (error instanceof ApiError) {
      respondJson(res, error.status, { error: error.message })
      return
    }
    logger?.warn?.(error)
    respondJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

export { TodoStore, TodoError, SCOPES, LEVELS, STATUSES, PRIORITIES } from './store.js'
// Exported for tests.
export { listProjects }

// Named exports only, like every first-party DSH plugin. The loader unwraps a
// module as `exports.default ?? exports`, so an extra default object is only a
// second, competing plugin shape here.
