/**
 * Invariant tests for `dsh-plugin-todo`.
 *
 * `store.test.js` pins the behaviour of each action one example at a time. This
 * file takes the opposite approach: it walks the **whole** `status × action ×
 * actor` matrix (8 × 11 × 2 = 176 combinations) and asserts the two promises the
 * plugin exists for hold everywhere, not just on the happy path:
 *
 * 1. the model can never accept its own proposal, confirm its own result, or
 *    mark anything done that a user did not confirm first;
 * 2. every todo that reaches `done` carries a recorded user confirmation;
 *
 * plus two mechanical properties: an illegal action always fails with a
 * `TodoError` (never a crash, never a partial write), and the model-facing action
 * menu never advertises a confirmation the model is not allowed to run.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { STATUSES, TodoError, TodoStore, availableActions } from '../lib/store.js'

const root = await mkdtemp(join(tmpdir(), 'todo-invariants-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

let sequence = 0
/** A store whose two levels live in their own directory, so tests never share a file. */
function freshStore() {
  sequence += 1
  return new TodoStore({
    cwd: join(root, `p${sequence}`),
    globalDir: join(root, `g${sequence}`),
    projectRootMarkers: [],
  })
}

/** Every action the matrix exercises, with the arguments it needs. */
const ACTIONS = {
  accept: {},
  claim: {},
  reject: {},
  reopen: {},
  void: { reason: '作废' },
  ask: { question: '还需要什么信息？' },
  answer: { text: '用环境变量 DSH_HOME 指定' },
  submit: { summary: '做完了' },
  confirm: {},
  complete: {},
  update: { detail: '补充说明' },
}

/**
 * Drive a fresh todo to one status using only legal transitions, and return the
 * store plus its id. This is the matrix's starting point for each row.
 * @param {string} status - the target status.
 * @returns {Promise<{ store: TodoStore, id: string }>} the fixture.
 */
async function at(status) {
  const store = freshStore()
  const create = async (origin) => (await store.create({ items: [{ title: '矩阵用待办' }], origin })).todos[0].id
  let id
  switch (status) {
    case 'proposed': id = await create('ai'); break
    case 'open': id = await create('user'); break
    case 'working': id = await create('user'); await store.act({ id, action: 'claim', actor: 'ai' }); break
    case 'blocked':
      id = await create('user')
      await store.act({ id, action: 'claim', actor: 'ai' })
      await store.act({ id, action: 'ask', actor: 'ai', question: 'q' })
      break
    case 'review':
      id = await create('user')
      await store.act({ id, action: 'claim', actor: 'ai' })
      await store.act({ id, action: 'submit', actor: 'ai', summary: 's' })
      break
    case 'confirmed':
      id = await create('user')
      await store.act({ id, action: 'claim', actor: 'ai' })
      await store.act({ id, action: 'submit', actor: 'ai', summary: 's' })
      await store.act({ id, action: 'confirm', actor: 'user' })
      break
    case 'done': id = await create('user'); await store.act({ id, action: 'complete', actor: 'user' }); break
    case 'void': id = await create('user'); await store.act({ id, action: 'void', actor: 'user', reason: 'r' }); break
    default: throw new Error(`no fixture for ${status}`)
  }
  const todo = await store.get({ id })
  assert.equal(todo.status, status, `fixture for ${status} produced ${todo.status}`)
  return { store, id }
}

describe('todo workflow invariants', () => {
  it('holds for every status × action × actor combination', async () => {
    const violations = []
    let succeeded = 0
    let refused = 0

    for (const status of STATUSES) {
      for (const [action, args] of Object.entries(ACTIONS)) {
        for (const actor of ['ai', 'user']) {
          const { store, id } = await at(status)
          let outcome
          try {
            const result = await store.act({ id, action, actor, ...args })
            outcome = result.todo.status
            succeeded += 1
          } catch (error) {
            refused += 1
            // (1) an illegal transition is a reported problem, never a crash.
            if (!(error instanceof TodoError)) violations.push(`${status}/${action}/${actor} threw ${error.constructor.name}: ${error.message}`)
          }
          const todo = await store.get({ id })

          // (2) `done` is only ever reached with a recorded user confirmation.
          if (todo.status === 'done' && (todo.approval === null || todo.approval.by !== 'user')) {
            violations.push(`${status}/${action}/${actor} reached done without a user approval`)
          }
          // (3) the confirmation actions belong to the user alone.
          if (actor === 'ai' && (action === 'accept' || action === 'confirm') && outcome !== undefined) {
            violations.push(`${status}/${action}/${actor} let the model confirm`)
          }
          // (4) the model completes only what the user already confirmed.
          if (actor === 'ai' && action === 'complete' && outcome !== undefined && status !== 'confirmed') {
            violations.push(`${status}/${action}/${actor} completed from ${status}`)
          }
          // (5) a refused action is a no-op, not a partial write.
          if (outcome === undefined) {
            const onDisk = await readFile(store.fileFor('project'), 'utf8')
            const line = onDisk.trim().split('\n').map((entry) => JSON.parse(entry)).find((entry) => entry.id === id)
            assert.equal(line.status, todo.status, `a refused ${action} still rewrote the file`)
          }
        }
      }
    }

    assert.deepEqual(violations, [])
    assert.equal(succeeded + refused, STATUSES.length * Object.keys(ACTIONS).length * 2)
    // A sanity floor: the matrix must actually exercise both outcomes.
    assert.ok(succeeded >= 50, `only ${succeeded} combinations succeeded`)
    assert.ok(refused >= 100, `only ${refused} combinations were refused`)
  })

  it('never advertises a confirmation the model may not run', () => {
    for (const status of STATUSES) {
      const ai = availableActions(status, 'ai')
      const user = availableActions(status, 'user')
      assert.ok(!ai.includes('accept'), `the model must not be offered accept (${status})`)
      assert.ok(!ai.includes('confirm'), `the model must not be offered confirm (${status})`)
      if (status !== 'confirmed') assert.ok(!ai.includes('complete'), `the model must not be offered complete before confirmation (${status})`)
      if (status === 'proposed') assert.ok(user.includes('accept'), 'the user must be offered accept on a proposal')
      if (status === 'review') assert.ok(user.includes('confirm'), 'the user must be offered confirm on a submission')
      if (status === 'done' || status === 'void') assert.equal(ai.length, 0, `a ${status} todo offers the model nothing`)
    }
  })

  it('reaches `done` from `review` only through the user', async () => {
    // The model's route: submit, then it is refused, then the user confirms, then it may finish.
    const { store, id } = await at('review')
    await assert.rejects(() => store.act({ id, action: 'complete', actor: 'ai' }), TodoError)
    await store.act({ id, action: 'confirm', actor: 'user' })
    const done = await store.act({ id, action: 'complete', actor: 'ai' })
    assert.equal(done.todo.status, 'done')
    assert.equal(done.todo.approval.by, 'user', 'the model consumed the user confirmation')

    // The user's route: one action, and that action writes the confirmation.
    const direct = await at('review')
    const completed = await direct.store.act({ id: direct.id, action: 'complete', actor: 'user' })
    assert.equal(completed.todo.status, 'done')
    assert.equal(completed.todo.approval.by, 'user')
    assert.equal(completed.todo.completion.by, 'user')
  })

  it('keeps a proposed todo proposed against every model action', async () => {
    const ai = await at('proposed')
    for (const action of ['accept', 'claim', 'confirm', 'submit', 'complete']) {
      await assert.rejects(
        () => ai.store.act({ id: ai.id, action, actor: 'ai', summary: 's', question: 'q' }),
        TodoError,
        `the model ran ${action} on its own proposal`,
      )
    }
    const todo = await ai.store.get({ id: ai.id })
    assert.equal(todo.status, 'proposed')
    assert.equal(todo.accepted, null)
    assert.equal(todo.approval, null)
  })
})
