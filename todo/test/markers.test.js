/**
 * Regression tests for project-root marker handling.
 *
 * A marker is compared against `<ancestor>/<marker>`, so a configured entry with
 * surrounding whitespace (`' .git '`) never matches and the store silently
 * resolves a project *inside* a repository to the session directory — filing its
 * todos beside the global ones instead of under the project. Both the config
 * normalizer and `findProjectRoot` itself therefore trim markers.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { findProjectRoot } from '../lib/store.js'
import { resolveOptions } from '../lib/index.js'

let root
before(async () => { root = await mkdtemp(join(tmpdir(), 'todo-markers-')) })
after(async () => { await rm(root, { recursive: true, force: true }) })

describe('project root markers', () => {
  it('trims padded markers so a real repository root still matches', async () => {
    const repo = join(root, 'repo')
    const deep = join(repo, 'packages', 'app')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(deep, { recursive: true })

    // The padded marker reaches the probe trimmed, so the .git ancestor matches.
    const probed = []
    const trimmed = findProjectRoot(deep, [' .git '], (path) => {
      probed.push(path)
      return path === join(repo, '.git')
    })
    assert.equal(trimmed, resolve(repo))
    assert.ok(probed.includes(join(repo, '.git')), 'the probe must use the trimmed marker')

    // End to end: the config normalizer keeps the trimmed value, so a store built
    // from a padded config lands on the repository root.
    assert.deepEqual(resolveOptions({ projectRootMarkers: [' .git '] }).projectRootMarkers, ['.git'])
    assert.deepEqual(resolveOptions({ projectRootMarkers: ['.git', '', 7, '  '] }).projectRootMarkers, ['.git'])
    // An explicit empty list still means "the session directory is the root".
    assert.deepEqual(resolveOptions({ projectRootMarkers: [] }).projectRootMarkers, [])
  })

  it('still ignores blank and non-string markers', () => {
    const lonely = join(root, 'lonely')
    assert.equal(findProjectRoot(lonely, ['', '   ', 7], () => true), resolve(lonely))
    assert.equal(findProjectRoot(lonely, [' .git '], () => false), resolve(lonely))
  })
})
