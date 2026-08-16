'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const createClientPlugin = require('../src/client-factory.cjs')

function browserStorage() {
  const values = new Map()
  global.window = {
    localStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
    },
  }
  return values
}

const React = {
  createElement: () => null,
  useEffect: () => {},
  useReducer: () => [0, () => {}],
}

test('one trigger cycles locally and requests a new batch after exhaustion', async () => {
  browserStorage()
  const calls = []
  const batches = [['A', 'B', 'C'], ['D', 'E', 'F'], ['G', 'H', 'I']]
  const plugin = createClientPlugin(React, {
    rpc: async (method, args) => {
      assert.equal(method, 'generate')
      calls.push(args)
      return { ok: true, candidates: batches[calls.length - 1] }
    },
  })
  const actions = { setDraft(value) { storeDraft = value } }
  let storeDraft = 'original'
  const testing = plugin._testing

  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'A')
  testing.observe('s1', storeDraft, 'idle')
  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'B')
  testing.observe('s1', storeDraft, 'idle')
  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'C')
  testing.observe('s1', storeDraft, 'idle')
  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'D')
  assert.deepEqual(calls[1].excluded, ['A', 'B', 'C'])
  assert.equal(calls[1].draft, 'original')

  testing.observe('s1', storeDraft, 'idle')
  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'E')
  testing.observe('s1', storeDraft, 'idle')
  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'F')
  testing.observe('s1', storeDraft, 'idle')
  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'G')
  assert.deepEqual(calls[2].excluded, ['D', 'E', 'F'])
})

test('a stale response never overwrites a draft edited while generation is running', async () => {
  browserStorage()
  let resolve
  const pending = new Promise((done) => { resolve = done })
  const plugin = createClientPlugin(React, { rpc: async () => pending })
  const writes = []
  const request = plugin._testing.trigger('s1', 'original', {
    setDraft: (value) => writes.push(value),
  })
  plugin._testing.observe('s1', 'manual edit', 'idle')
  resolve({ ok: true, candidates: ['A', 'B', 'C'] })
  await request
  assert.deepEqual(writes, [])
  assert.equal(plugin._testing.storeFor('s1').phase, 'idle')
})

test('remote rejection becomes a retryable user-safe error', async () => {
  browserStorage()
  const plugin = createClientPlugin(React, { rpc: async () => { throw new Error('secret detail') } })
  await plugin._testing.trigger('s1', '', { setDraft() {} })
  const store = plugin._testing.storeFor('s1')
  assert.equal(store.phase, 'error')
  assert.equal(store.error, 'Prompt for Me could not reach the Harness Host.')
})

test('submission and cycling outcomes stay bounded in browser-local storage', async () => {
  const values = browserStorage()
  const plugin = createClientPlugin(React, {
    rpc: async () => ({ ok: true, candidates: ['A', 'B', 'C'] }),
  })
  plugin._testing.config.maxLocalOutcomes = 2
  let draft = ''
  const actions = { setDraft: (value) => { draft = value } }
  await plugin._testing.trigger('s1', draft, actions)
  plugin._testing.observe('s1', draft, 'idle')
  await plugin._testing.trigger('s1', draft, actions)
  plugin._testing.observe('s1', draft, 'submitting')
  plugin._testing.recordOutcome('extra', 'edited', 'manual')
  const records = JSON.parse(values.get('dsh.prompt-for-me.outcomes.v1'))
  assert.equal(records.length, 2)
  assert.deepEqual(records.map((record) => record.kind), ['submitted-exact', 'edited'])
})

test('the portable shortcut accepts exactly one platform modifier', () => {
  browserStorage()
  const plugin = createClientPlugin(React, { rpc: async () => ({ ok: true }) })
  const matches = plugin._testing.shortcutMatches
  assert.equal(matches({ key: ' ', code: 'Space', shiftKey: true, metaKey: true, ctrlKey: false, altKey: false }), true)
  assert.equal(matches({ key: ' ', code: 'Space', shiftKey: true, metaKey: false, ctrlKey: true, altKey: false }), true)
  assert.equal(matches({ key: ' ', code: 'Space', shiftKey: true, metaKey: true, ctrlKey: true, altKey: false }), false)
  assert.equal(matches({ key: ' ', code: 'Space', shiftKey: false, metaKey: true, ctrlKey: false, altKey: false }), false)
})
