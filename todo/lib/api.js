/**
 * JSON API behind the todo panel.
 *
 * `createTodoApi` owns every decision (routing, validation, state shape) and
 * returns a framework-free `handle(request)` result, so the same code is unit
 * testable and is what the host's HTTP route calls. The client half talks to it
 * over the Web server under {@link API_PREFIX}.
 *
 * Two routes are not plain CRUD:
 *
 * - `POST /action` runs the workflow machine in `store.js` as the `user` actor.
 *   That is the only way a todo becomes `open` (accept a proposal) or
 *   `confirmed` (confirm a submitted result), which is what makes the model's
 *   own completion path safe.
 * - `POST /request` hands one todo to the model: the host delivers a user-role
 *   message into the live session (see the host half) and the panel reports
 *   whether it was delivered. When it cannot be delivered the prepared prompt is
 *   returned instead, so the user can paste it into the conversation.
 *
 * Requests must carry the {@link CLIENT_HEADER} marker header: a custom header
 * cannot be attached by a cross-site form or image request without a CORS
 * preflight this route never approves. The route otherwise reuses the host's own
 * browser-session gate (`connection.requestRejection`).
 *
 * @module dsh-plugin-todo/api
 */

import { isAbsolute } from 'node:path'
import { STATUSES, TodoError, availableActions, needsAttention, summarize } from './store.js'

/** Route prefix every todo API request starts with. */
export const API_PREFIX = '/api/todo'
/** Marker header the browser half sends and every handler requires. */
export const CLIENT_HEADER = 'x-todo-client'
/** Largest accepted request body, in bytes. */
export const MAX_BODY_BYTES = 256 * 1024
/** Fields `POST /action` forwards to the store. */
const ACTION_STRING_FIELDS = ['note', 'reason', 'question', 'text', 'summary', 'evidence', 'title', 'detail', 'acceptance', 'priority']
/** How `POST /request` chooses the session it hands a todo to. */
export const REQUEST_TARGETS = ['current', 'session', 'new']
/** Sessions `GET /sessions` returns when the caller omits `limit`. */
export const DEFAULT_SESSION_LIMIT = 25

/** A rejected request carrying its HTTP status. */
export class ApiError extends Error {
  /**
   * @param {number} status - HTTP status this failure answers with.
   * @param {string} message - the caller-facing problem.
   */
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * Read one string field.
 * @param {unknown} value - raw field value.
 * @param {string} field - field name for the error message.
 * @param {{ required?: boolean }} [options] - whether absence is an error.
 * @returns {string | undefined} the raw value.
 */
function readString(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, `${field} must be a non-blank string`)
    return undefined
  }
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a string`)
  return value
}

/**
 * Read one request body field as an object, rejecting arrays and scalars.
 * @param {unknown} body - parsed request body.
 * @returns {Record<string, unknown>} the body object.
 */
function readBody(body) {
  if (body === undefined || body === null) return {}
  if (typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'request body must be a JSON object')
  return body
}

/**
 * Read a non-negative integer field.
 * @param {unknown} value - raw field value.
 * @param {string} field - field name for the error message.
 * @returns {number | undefined} the parsed value.
 */
function readCount(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new ApiError(400, `${field} must be a non-negative integer`)
  return parsed
}

/**
 * The message the panel hands to the model when the user asks it to finish one
 * todo. It is a user-role message, so it reads as an ordinary request in
 * conversation history.
 * @param {object} input - prompt input.
 * @param {Record<string, unknown>} input.todo - the todo being requested.
 * @param {string} [input.projectRoot] - the project the todo belongs to.
 * @returns {string} the prompt text.
 */
export function buildRequestPrompt({ todo, projectRoot }) {
  const lines = [
    '请完成下面这条待办事项。',
    '',
    `id: ${todo.id}`,
    `标题: ${todo.title}`,
    `状态: ${todo.status}`,
    `级别: ${todo.scope}`,
  ]
  if (typeof projectRoot === 'string' && projectRoot.length > 0) lines.push(`项目: ${projectRoot}`)
  lines.push(`优先级: ${todo.priority}`)
  if (Array.isArray(todo.tags) && todo.tags.length > 0) lines.push(`标签: ${todo.tags.join(', ')}`)
  lines.push(`说明: ${todo.detail.length > 0 ? todo.detail : '（空）'}`)
  lines.push(`验收标准: ${todo.acceptance.length > 0 ? todo.acceptance : '（未填写，必要时先向用户确认）'}`)
  if (Array.isArray(todo.answers) && todo.answers.length > 0) {
    lines.push('已有回答:')
    for (const answer of todo.answers) lines.push(`- ${answer.text}`)
  }
  lines.push(
    '',
    '执行流程：',
    `1. 先调用 todo_get(id="${todo.id}") 读取服务端最新详情。`,
    '2. 判断信息是否足够完成这条待办。如果不够，先向用户提问获取必要信息；也可以调用 todo_update(id, question="...") 把缺少什么记录到待办上，用户会在待办面板里回答。信息补全后再继续。',
    `3. 信息足够后调用 todo_claim(id="${todo.id}") 表示开始处理，然后完成它。`,
    '4. 完成后调用 todo_submit(id, summary="...", evidence="...") 提交结果，并请用户在待办面板确认。',
    '   注意：用户确认之前不能把待办标记成已完成；用户确认后调用 todo_complete(id) 收尾。',
    `5. 如果这条待办不该做，调用 todo_void(id="${todo.id}", reason="...") 说明原因。`,
  )
  return lines.join('\n')
}

/**
 * Build the todo panel API.
 * @param {object} options - API dependencies.
 * @param {(cwd: string) => import('./store.js').TodoStore} options.storeFor - store per session directory.
 * @param {() => Array<{ path: string, title: string }>} [options.listProjects] - registered project directories.
 * @param {(request: { headers: Record<string, unknown> }) => 401 | 403 | undefined} [options.admit] - the host's browser-session gate (`connection.requestRejection`); omitted means no gate.
 * @param {(sessionId: string) => string | undefined} [options.resolveSessionCwd] - working directory of a live session, so the panel follows the project the user is in.
 * @param {(input: { limit?: number }) => Promise<Array<Record<string, unknown>> | undefined>} [options.listSessions] - the host's session list, so the panel can offer a target picker; omitted means "current session only".
 * @param {(input: { cwd: string }) => Promise<{ sessionId: string } | undefined>} [options.createSession] - the host's session factory, for "new session"; omitted hides that choice.
 * @param {(input: { sessionId: string, prompt: string, todo: Record<string, unknown> }) => Promise<{ delivered: boolean, reason?: string }>} [options.deliverRequest] - hands a request to the model; omitted means the panel only offers the prompt.
 * @returns {{ handle: (request: { method: string, pathname: string, query?: Record<string, string | undefined>, headers?: Record<string, unknown>, body?: unknown }) => Promise<{ status: number, body: unknown }> }} the API.
 */
export function createTodoApi({ storeFor, listProjects = () => [], admit, resolveSessionCwd, listSessions, createSession, deliverRequest }) {
  /**
   * Resolve one request to the store it addresses plus the project it selected.
   *
   * Precedence: an explicit `project` (the panel's manual choice), else the
   * `session` the panel is following (its live cwd), else the most recently
   * updated registered workspace, else the host process directory.
   * @param {Record<string, unknown>} source - body object or query map.
   * @returns {{ store: import('./store.js').TodoStore, current: { source: string, path: string, projectRoot: string } }} the resolution.
   */
  const resolve = (source) => {
    const project = readString(source.project, 'project')
    if (project !== undefined) {
      const store = storeFor(project)
      return { store, current: { source: 'manual', path: project, projectRoot: store.projectRoot } }
    }
    const session = readString(source.session, 'session')
    const sessionCwd = session === undefined || resolveSessionCwd === undefined ? undefined : resolveSessionCwd(session)
    if (sessionCwd !== undefined && sessionCwd !== null && sessionCwd !== '') {
      const store = storeFor(sessionCwd)
      return { store, current: { source: 'session', path: store.cwd, projectRoot: store.projectRoot } }
    }
    const fallback = listProjects()[0]?.path ?? process.cwd()
    const store = storeFor(fallback)
    return { store, current: { source: 'default', path: fallback, projectRoot: store.projectRoot } }
  }

  /**
   * One level's listing, or its disabled marker. Detail stays on the server: a
   * row only needs the summary, and `GET /todo` fetches the full record.
   * @param {import('./store.js').TodoStore} store - the request's store.
   * @param {'global' | 'project'} scope - level to describe.
   * @param {number | undefined} limit - maximum todos to include; omitted means every todo.
   * @param {string | undefined} status - status filter.
   * @returns {Promise<Record<string, unknown>>} the level payload.
   */
  const levelOf = async (store, scope, limit, status) => {
    if (!store.scopes.includes(scope)) return { scope, enabled: false, todos: [], total: 0, counts: {} }
    const listing = await store.list({ scope, limit, status })
    return {
      scope,
      enabled: true,
      dir: store.dirFor(scope),
      file: store.fileFor(scope),
      total: listing.total,
      counts: listing.counts,
      todos: listing.todos.map((todo) => summarize(todo)),
    }
  }

  /**
   * The full panel state for one store.
   * @param {import('./store.js').TodoStore} store - the request's store.
   * @param {number | undefined} limit - maximum todos per level.
   * @param {string | undefined} status - status filter.
   * @param {{ source: string, path: string, projectRoot: string }} current - the project this request resolved to.
   * @returns {Promise<Record<string, unknown>>} the state payload.
   */
  const stateOf = async (store, limit, status, current) => ({
    level: store.level,
    defaultScope: store.defaultScope,
    cwd: store.cwd,
    projectRoot: store.projectRoot,
    current,
    projects: listProjects(),
    statuses: [...STATUSES],
    canDeliver: typeof deliverRequest === 'function',
    levels: {
      global: await levelOf(store, 'global', limit, status),
      project: await levelOf(store, 'project', limit, status),
    },
  })

  /**
   * One level's fresh listing after a mutation. Every todo is returned: rows are
   * summaries, so a full refresh stays small.
   * @param {import('./store.js').TodoStore} store - the request's store.
   * @param {'global' | 'project'} scope - the mutated level.
   * @returns {Promise<Record<string, unknown>>} the level payload.
   */
  const afterMutation = async (store, scope) => ({ ok: true, ...await levelOf(store, scope, 0, undefined) })

  /**
   * The full record of one todo, reached by id from the resolved store.
   * @param {import('./store.js').TodoStore} store - the request's store.
   * @param {string} id - todo id.
   * @param {'global' | 'project'} [scope] - level override.
   * @returns {Promise<Record<string, unknown>>} the todo payload.
   * @throws {ApiError} 404 when the todo does not exist.
   */
  const recordOf = async (store, id, scope) => {
    const located = await store.locate({ id, scope })
    if (located.todo === undefined) throw new ApiError(404, `no todo ${JSON.stringify(id)}`)
    return {
      ...located.todo,
      file: store.fileFor(located.scope),
      // The project the todo lives in: the panel offers it as the working
      // directory of a session the user asks it to create.
      projectRoot: store.projectRoot,
      actions: availableActions(located.todo.status, 'user'),
      attention: needsAttention(located.todo.status),
    }
  }

  /**
   * The sessions the panel may hand a todo to.
   *
   * `listSessions` is the host's session business API; when the deployment has
   * none (headless, SDK) the panel still offers the current session and the
   * prepared prompt, so `canList`/`canCreate` drive the UI instead of failing.
   * Subagent sessions are filtered out by the host: they are not conversations
   * the user can hand work to.
   * @param {{ projectRoot: string }} current - the project this request resolved to.
   * @param {number | undefined} limit - maximum sessions returned.
   * @param {string | undefined} query - case-insensitive filter over title and cwd.
   * @returns {Promise<Record<string, unknown>>} the session payload.
   */
  const sessionsOf = async (current, limit, query) => {
    if (listSessions === undefined) return { ok: true, canList: false, canCreate: false, sessions: [] }
    let sessions
    try {
      sessions = await listSessions({ limit: limit ?? DEFAULT_SESSION_LIMIT })
    } catch (error) {
      throw new ApiError(502, `could not list sessions: ${error instanceof Error ? error.message : String(error)}`)
    }
    let items = Array.isArray(sessions) ? sessions : []
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
    if (needle.length > 0) {
      items = items.filter((session) =>
        String(session.title ?? '').toLowerCase().includes(needle)
        || String(session.cwd ?? '').toLowerCase().includes(needle)
        || String(session.id).toLowerCase().includes(needle))
    }
    return {
      ok: true,
      canList: true,
      canCreate: typeof createSession === 'function',
      sessions: items.map((session) => ({
        ...session,
        sameProject: session.projectRoot !== null && session.projectRoot !== undefined && session.projectRoot === current.projectRoot,
      })),
    }
  }

  /**
   * Answer one API request.
   * @param {object} request - the parsed request.
   * @param {string} request.method - HTTP method.
   * @param {string} request.pathname - absolute pathname.
   * @param {Record<string, string | undefined>} [request.query] - query parameters.
   * @param {Record<string, unknown>} [request.headers] - lowercased request headers.
   * @param {unknown} [request.body] - parsed JSON body.
   * @returns {Promise<{ status: number, body: unknown }>} the response.
   */
  const handle = async ({ method, pathname, query = {}, headers = {}, body }) => {
    try {
      // The host's own browser-session gate first: this route shadows the
      // API-gateway prefix, so it must apply the same Host/Origin fence and
      // cookie authentication the framework applies to its own routes.
      const rejection = admit === undefined ? undefined : admit({ headers })
      if (rejection !== undefined) {
        return {
          status: rejection,
          body: {
            error: rejection === 401
              ? 'unauthenticated: open the todo panel from the GUI (its browser session cookie is required)'
              : 'rejected: the request failed the host/origin fence',
          },
        }
      }
      if (headers[CLIENT_HEADER] !== '1') throw new ApiError(403, `missing ${CLIENT_HEADER} header`)
      const route = pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
      const verb = String(method ?? 'GET').toUpperCase()

      if (route === '/state') {
        if (verb !== 'GET') throw new ApiError(405, `${verb} is not allowed on ${API_PREFIX}/state`)
        const { store, current } = resolve(query)
        return { status: 200, body: await stateOf(store, readCount(query.limit, 'limit'), readString(query.status, 'status'), current) }
      }

      if (route === '/prompt') {
        if (verb !== 'GET') throw new ApiError(405, `${verb} is not allowed on ${API_PREFIX}/prompt`)
        const { store, current } = resolve(query)
        const id = readString(query.id, 'id', { required: true })
        const todo = await recordOf(store, id, readString(query.scope, 'scope'))
        return { status: 200, body: { ok: true, id: todo.id, prompt: buildRequestPrompt({ todo, projectRoot: current.projectRoot }) } }
      }

      if (route === '/sessions') {
        if (verb !== 'GET') throw new ApiError(405, `${verb} is not allowed on ${API_PREFIX}/sessions`)
        const { current } = resolve(query)
        return {
          status: 200,
          body: {
            ...await sessionsOf(current, readCount(query.limit, 'limit'), readString(query.query, 'query')),
            current: readString(query.session, 'session') ?? null,
            projectRoot: current.projectRoot,
          },
        }
      }

      if (route === '/todo') {
        if (verb !== 'GET') throw new ApiError(405, `${verb} is not allowed on ${API_PREFIX}/todo`)
        const { store } = resolve(query)
        const id = readString(query.id, 'id', { required: true })
        return { status: 200, body: { ok: true, todo: await recordOf(store, id, readString(query.scope, 'scope')) } }
      }

      if (route === '/todos') {
        if (verb !== 'POST') throw new ApiError(405, `${verb} is not allowed on ${API_PREFIX}/todos`)
        const input = readBody(body)
        const { store } = resolve(input)
        const scope = readString(input.scope, 'scope')
        const item = {
          title: readString(input.title, 'title', { required: true }),
          detail: readString(input.detail, 'detail'),
          acceptance: readString(input.acceptance, 'acceptance'),
          priority: readString(input.priority, 'priority'),
          tags: input.tags === undefined ? [] : input.tags,
        }
        if (!Array.isArray(item.tags)) throw new ApiError(400, 'tags must be an array of strings')
        const added = await store.create({ items: [item], scope, origin: 'user' })
        const created = added.todos[0]
        return { status: 201, body: { ...await afterMutation(store, added.scope), todo: summarize(created) } }
      }

      if (route === '/action') {
        if (verb !== 'POST') throw new ApiError(405, `${verb} is not allowed on ${API_PREFIX}/action`)
        const input = readBody(body)
        const { store } = resolve(input)
        const id = readString(input.id, 'id', { required: true })
        const action = readString(input.action, 'action', { required: true })
        const fields = { id, action, actor: 'user', scope: readString(input.scope, 'scope') }
        for (const field of ACTION_STRING_FIELDS) {
          const value = readString(input[field], field)
          if (value !== undefined) fields[field] = value
        }
        if (input.tags !== undefined) {
          if (!Array.isArray(input.tags)) throw new ApiError(400, 'tags must be an array of strings')
          fields.tags = input.tags
        }
        const result = await store.act(fields)
        return { status: 200, body: { ...await afterMutation(store, result.scope), todo: summarize(result.todo) } }
      }

      if (route === '/request') {
        if (verb !== 'POST') throw new ApiError(405, `${verb} is not allowed on ${API_PREFIX}/request`)
        const input = readBody(body)
        const { store, current } = resolve(input)
        const id = readString(input.id, 'id', { required: true })
        const todo = await recordOf(store, id, readString(input.scope, 'scope'))
        // A project-level todo is handed over inside its own project; a global one
        // needs the caller to say where the work should happen.
        const promptProject = todo.scope === 'global' && readString(input.cwd, 'cwd') !== undefined
          ? String(input.cwd).trim()
          : current.projectRoot
        const prompt = buildRequestPrompt({ todo, projectRoot: promptProject })
        if (deliverRequest === undefined) {
          return { status: 409, body: { error: 'this deployment does not deliver requests to the model (`deliverRequests: false`); copy the prompt and send it yourself', prompt } }
        }

        const target = readString(input.target, 'target') ?? 'current'
        if (!REQUEST_TARGETS.includes(target)) {
          throw new ApiError(400, `unknown target ${JSON.stringify(target)}: expected one of ${REQUEST_TARGETS.join(', ')}`)
        }
        /** The session the delivery goes to, plus whether this call created it. */
        let sessionId = readString(input.session, 'session') ?? readString(query.session, 'session')
        let created = false
        if (target === 'session') {
          sessionId = readString(input.targetSession, 'targetSession', { required: true })
        } else if (target === 'new') {
          if (createSession === undefined) {
            return { status: 409, body: { error: 'this deployment cannot create sessions; pick an existing session instead, or copy the prompt and send it yourself', prompt } }
          }
          // Project-level todos already know their project; global ones must name
          // one, and the panel always sends the project it is showing as a default.
          const cwd = readString(input.cwd, 'cwd') ?? store.projectRoot
          if (!isAbsolute(cwd)) throw new ApiError(400, `cwd must be an absolute path (got ${JSON.stringify(cwd)})`)
          let made
          try {
            made = await createSession({ cwd })
          } catch (error) {
            return { status: 409, body: { error: `could not create a session in ${cwd}: ${error instanceof Error ? error.message : String(error)}`, prompt } }
          }
          if (made === undefined || made === null || typeof made.sessionId !== 'string' || made.sessionId.length === 0) {
            return { status: 409, body: { error: `the host refused to create a session in ${cwd}`, prompt } }
          }
          sessionId = made.sessionId
          created = true
        }
        if (sessionId === undefined) {
          return { status: 409, body: { error: 'no live session to hand this todo to: open the todo panel from a conversation, or copy the prompt and send it yourself', prompt } }
        }

        const outcome = await deliverRequest({ sessionId, prompt, todo })
        if (outcome.delivered !== true) {
          return { status: 409, body: { error: outcome.reason ?? 'the request could not be delivered to the model', prompt, sessionId, created } }
        }
        // Record the handoff so the panel shows it as in progress. A refusal here
        // is harmless: the model claims the todo itself once it starts.
        let claimed = false
        try {
          await store.act({ id: todo.id, action: 'claim', actor: 'user', scope: todo.scope, note: 'the user asked the model to do it' })
          claimed = true
        } catch (error) {
          if (!(error instanceof TodoError)) throw error
        }
        return { status: 200, body: { ...await afterMutation(store, todo.scope), ok: true, delivered: true, claimed, prompt, sessionId, created, target } }
      }

      throw new ApiError(404, `unknown todo route ${JSON.stringify(pathname)}`)
    } catch (error) {
      if (error instanceof ApiError) return { status: error.status, body: { error: error.message } }
      if (error instanceof TodoError) return { status: 400, body: { error: error.message } }
      if (error instanceof TypeError) return { status: 400, body: { error: error.message } }
      return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } }
    }
  }

  return { handle }
}
