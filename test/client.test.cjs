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

function batchGenerator(batches, calls = []) {
  return {
    calls,
    generate: async (args, onCandidate) => {
      calls.push(args)
      const batch = batches[calls.length - 1]
      for (const candidate of batch) await onCandidate(candidate)
      return { ok: true, batchId: `batch-${calls.length}` }
    },
  }
}

function controlledClock() {
  let time = 1000
  return {
    advance(milliseconds = 251) { time += milliseconds },
    now() { return time },
  }
}

test('one trigger cycles locally and requests a new batch after exhaustion', async () => {
  browserStorage()
  const batches = [['A', 'B', 'C'], ['D', 'E', 'F'], ['G', 'H', 'I']]
  const generator = batchGenerator(batches)
  const clock = controlledClock()
  const plugin = createClientPlugin(React, { generate: generator.generate, now: clock.now })
  const actions = { setDraft(value) { storeDraft = value } }
  let storeDraft = 'original'
  const testing = plugin._testing

  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'A')
  testing.observe('s1', storeDraft, 'idle')
  clock.advance()
  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'B')
  testing.observe('s1', storeDraft, 'idle')
  clock.advance()
  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'C')
  testing.observe('s1', storeDraft, 'idle')
  clock.advance()
  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'D')
  assert.deepEqual(generator.calls[1].excluded, ['A', 'B', 'C'])
  assert.equal(generator.calls[1].draft, 'original')
  assert.deepEqual(generator.calls[1].localOutcomes.map(({ sessionId, action, origin, originalText }) => ({
    sessionId, action, origin, originalText,
  })), [
    { sessionId: 's1', action: 'cycled', origin: 'suggestion-exact', originalText: 'A' },
    { sessionId: 's1', action: 'cycled', origin: 'suggestion-exact', originalText: 'B' },
    { sessionId: 's1', action: 'cycled', origin: 'suggestion-exact', originalText: 'C' },
  ])

  testing.observe('s1', storeDraft, 'idle')
  clock.advance()
  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'E')
  testing.observe('s1', storeDraft, 'idle')
  clock.advance()
  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'F')
  testing.observe('s1', storeDraft, 'idle')
  clock.advance()
  await testing.trigger('s1', storeDraft, actions)
  assert.equal(storeDraft, 'G')
  assert.deepEqual(generator.calls[2].excluded, ['D', 'E', 'F'])
})

test('the first complete candidate reaches the draft before the batch finishes', async () => {
  browserStorage()
  let releaseRemaining
  const remaining = new Promise((resolve) => { releaseRemaining = resolve })
  let firstVisible
  const visible = new Promise((resolve) => { firstVisible = resolve })
  const plugin = createClientPlugin(React, {
    generate: async (args, onCandidate) => {
      await onCandidate('A')
      firstVisible()
      await remaining
      await onCandidate('B')
      await onCandidate('C')
      return { ok: true, batchId: 'batch-1' }
    },
  })
  let draft = 'original'
  const pending = plugin._testing.trigger('s1', draft, {
    setDraft: (value) => { draft = value },
  })

  await visible
  assert.equal(draft, 'A')
  assert.equal(plugin._testing.storeFor('s1').pending, true)
  releaseRemaining()
  await pending
  assert.deepEqual(plugin._testing.storeFor('s1').candidates, ['A', 'B', 'C'])
})

test('the browser transport parses candidates across arbitrary NDJSON chunks', async () => {
  browserStorage()
  const encoder = new TextEncoder()
  window.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"type":"candidate","index":0,"candi'))
      controller.enqueue(encoder.encode('date":"A"}\n{"type":"candidate","index":1,"candidate":"B"}\n'))
      controller.enqueue(encoder.encode('{"type":"candidate","index":2,"candidate":"C"}\n'))
      controller.enqueue(encoder.encode('{"type":"done","batchId":"batch-1","count":3}\n'))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
  const plugin = createClientPlugin(React)
  let draft = ''
  await plugin._testing.trigger('s1', draft, {
    setDraft: (value) => { draft = value },
  })
  assert.equal(draft, 'A')
  assert.deepEqual(plugin._testing.storeFor('s1').candidates, ['A', 'B', 'C'])
})

test('trigger waits for the next progressive candidate when it is not ready yet', async () => {
  browserStorage()
  let releaseNext
  const next = new Promise((resolve) => { releaseNext = resolve })
  let firstVisible
  const visible = new Promise((resolve) => { firstVisible = resolve })
  const clock = controlledClock()
  const plugin = createClientPlugin(React, {
    now: clock.now,
    generate: async (args, onCandidate) => {
      await onCandidate('A')
      firstVisible()
      await next
      await onCandidate('B')
      await onCandidate('C')
      return { ok: true, batchId: 'batch-1' }
    },
  })
  let draft = ''
  const actions = { setDraft: (value) => { draft = value } }
  const pending = plugin._testing.trigger('s1', draft, actions)
  await visible
  plugin._testing.observe('s1', draft, 'idle')
  clock.advance()
  await plugin._testing.trigger('s1', draft, actions)
  assert.equal(draft, 'A')
  assert.equal(plugin._testing.storeFor('s1').phase, 'loading')
  releaseNext()
  await pending
  assert.equal(draft, 'B')
})

test('rapid triggers advance at most once after the applied draft is acknowledged', async () => {
  const values = browserStorage()
  const clock = controlledClock()
  const generator = batchGenerator([['A', 'B', 'C'], ['D', 'E', 'F']])
  const plugin = createClientPlugin(React, { generate: generator.generate, now: clock.now })
  let draft = 'original'
  const actions = { setDraft: (value) => { draft = value } }
  const testing = plugin._testing

  await testing.trigger('s1', draft, actions)
  assert.equal(draft, 'A')
  await Promise.all([
    testing.trigger('s1', 'original', actions),
    testing.trigger('s1', 'original', actions),
  ])
  assert.equal(draft, 'A')
  assert.equal(generator.calls.length, 1)

  testing.observe('s1', draft, 'idle')
  clock.advance(249)
  await testing.trigger('s1', draft, actions)
  assert.equal(draft, 'A')

  clock.advance(1)
  await testing.trigger('s1', draft, actions)
  assert.equal(draft, 'B')
  await testing.trigger('s1', 'A', actions)
  assert.equal(draft, 'B')
  assert.equal(generator.calls.length, 1)
  assert.deepEqual(
    JSON.parse(values.get('dsh.prompt-for-me.outcomes.v2')).map((item) => item.originalText),
    ['A'],
  )
})

test('editing while waiting for the next candidate prevents a late overwrite', async () => {
  browserStorage()
  const clock = controlledClock()
  let releaseNext
  const next = new Promise((resolve) => { releaseNext = resolve })
  let firstVisible
  const visible = new Promise((resolve) => { firstVisible = resolve })
  const plugin = createClientPlugin(React, {
    now: clock.now,
    generate: async (args, onCandidate) => {
      await onCandidate('A')
      firstVisible()
      await next
      await onCandidate('B')
      await onCandidate('C')
      return { ok: true, batchId: 'batch-1' }
    },
  })
  let draft = ''
  const actions = { setDraft: (value) => { draft = value } }
  const pending = plugin._testing.trigger('s1', draft, actions)
  await visible
  plugin._testing.observe('s1', draft, 'idle')
  clock.advance()
  await plugin._testing.trigger('s1', draft, actions)
  draft = ''
  plugin._testing.observe('s1', draft, 'idle')
  releaseNext()
  await pending

  assert.equal(draft, '')
  assert.equal(plugin._testing.storeFor('s1').awaitingNext, false)
  assert.equal(plugin._testing.storeFor('s1').phase, 'ready')
})

test('a stale response never overwrites a draft edited while generation is running', async () => {
  browserStorage()
  let resolve
  const pending = new Promise((done) => { resolve = done })
  const plugin = createClientPlugin(React, {
    generate: async (args, onCandidate) => {
      const candidates = await pending
      for (const candidate of candidates) await onCandidate(candidate)
      return { ok: true }
    },
  })
  const writes = []
  const request = plugin._testing.trigger('s1', 'original', {
    setDraft: (value) => writes.push(value),
  })
  plugin._testing.observe('s1', 'manual edit', 'idle')
  resolve(['A', 'B', 'C'])
  await request
  assert.deepEqual(writes, [])
  assert.equal(plugin._testing.storeFor('s1').phase, 'idle')
})

test('remote rejection becomes a retryable user-safe error', async () => {
  browserStorage()
  const plugin = createClientPlugin(React, {
    generate: async () => { throw new Error('secret detail') },
  })
  await plugin._testing.trigger('s1', '', { setDraft() {} })
  const store = plugin._testing.storeFor('s1')
  assert.equal(store.phase, 'error')
  assert.equal(store.error, 'Prompt for Me could not reach the Harness Host.')
})

test('submission and cycling outcomes stay bounded in browser-local storage', async () => {
  const values = browserStorage()
  const generator = batchGenerator([['A', 'B', 'C']])
  const clock = controlledClock()
  const plugin = createClientPlugin(React, { generate: generator.generate, now: clock.now })
  plugin._testing.config.maxLocalOutcomes = 2
  let draft = ''
  const actions = { setDraft: (value) => { draft = value } }
  await plugin._testing.trigger('s1', draft, actions)
  plugin._testing.observe('s1', draft, 'idle')
  clock.advance()
  await plugin._testing.trigger('s1', draft, actions)
  plugin._testing.observe('s1', draft, 'submitting')
  plugin._testing.recordOutcome('s2', {
    action: 'cycled',
    origin: 'suggestion-edited',
    originalText: 'extra',
    finalText: 'manual',
  })
  const records = JSON.parse(values.get('dsh.prompt-for-me.outcomes.v2'))
  assert.equal(records.length, 2)
  assert.deepEqual(records.map(({ sessionId, action, origin, originalText, finalText }) => ({
    sessionId, action, origin, originalText, finalText,
  })), [
    {
      sessionId: 's1', action: 'submitted', origin: 'suggestion-exact',
      originalText: 'B', finalText: 'B',
    },
    {
      sessionId: 's2', action: 'cycled', origin: 'suggestion-edited',
      originalText: 'extra', finalText: 'manual',
    },
  ])
})

test('legacy V1 outcomes migrate once to session-aware V2 records', () => {
  const values = browserStorage()
  values.set('dsh.prompt-for-me.outcomes.v1', JSON.stringify([
    { kind: 'submitted-exact', candidate: 'accepted', at: 1 },
    { kind: 'submitted-edited', candidate: 'original', resultingText: 'edited', at: 2 },
    { kind: 'cycled', candidate: 'rejected', at: 3 },
    { kind: 'edited', candidate: 'rewritten', resultingText: 'new draft', at: 4 },
  ]))
  const plugin = createClientPlugin(React)

  assert.deepEqual(plugin._testing.readOutcomes(), [
    {
      sessionId: null, action: 'submitted', origin: 'suggestion-exact',
      originalText: 'accepted', finalText: 'accepted', at: 1,
    },
    {
      sessionId: null, action: 'submitted', origin: 'suggestion-edited',
      originalText: 'original', finalText: 'edited', at: 2,
    },
    {
      sessionId: null, action: 'cycled', origin: 'suggestion-exact',
      originalText: 'rejected', at: 3,
    },
    {
      sessionId: null, action: 'cycled', origin: 'suggestion-edited',
      originalText: 'rewritten', finalText: 'new draft', at: 4,
    },
  ])
  assert.equal(values.has('dsh.prompt-for-me.outcomes.v1'), true)
  assert.equal(values.has('dsh.prompt-for-me.outcomes.v2'), true)
})

test('manual and edited submissions record provenance once per submission transition', async () => {
  const values = browserStorage()
  const generator = batchGenerator([['A', 'B', 'C']])
  const plugin = createClientPlugin(React, { generate: generator.generate })

  plugin._testing.observe('manual-session', 'typed by user', 'idle')
  plugin._testing.observe('manual-session', 'typed by user', 'submitting')
  plugin._testing.observe('manual-session', 'typed by user', 'submitting')

  let draft = ''
  await plugin._testing.trigger('suggested-session', draft, {
    setDraft: (value) => { draft = value },
  })
  plugin._testing.observe('suggested-session', draft, 'idle')
  draft = 'A with a manual correction'
  plugin._testing.observe('suggested-session', draft, 'idle')
  plugin._testing.observe('suggested-session', draft, 'submitting')

  const records = JSON.parse(values.get('dsh.prompt-for-me.outcomes.v2'))
  assert.equal(records.length, 2)
  assert.deepEqual(records.map(({ sessionId, action, origin, originalText, finalText }) => ({
    sessionId, action, origin, originalText, finalText,
  })), [
    {
      sessionId: 'manual-session', action: 'submitted', origin: 'manual',
      originalText: undefined, finalText: 'typed by user',
    },
    {
      sessionId: 'suggested-session', action: 'submitted', origin: 'suggestion-edited',
      originalText: 'A', finalText: 'A with a manual correction',
    },
  ])
})

test('the portable shortcut accepts exactly one platform modifier', () => {
  browserStorage()
  const plugin = createClientPlugin(React, { rpc: async () => ({ ok: true }) })
  const matches = plugin._testing.shortcutMatches
  assert.equal(matches({ key: ' ', code: 'Space', shiftKey: true, metaKey: true, ctrlKey: false, altKey: false }), true)
  assert.equal(matches({ key: ' ', code: 'Space', shiftKey: true, metaKey: true, ctrlKey: false, altKey: false, repeat: true }), false)
  assert.equal(matches({ key: ' ', code: 'Space', shiftKey: true, metaKey: false, ctrlKey: true, altKey: false }), true)
  assert.equal(matches({ key: ' ', code: 'Space', shiftKey: true, metaKey: true, ctrlKey: true, altKey: false }), false)
  assert.equal(matches({ key: ' ', code: 'Space', shiftKey: false, metaKey: true, ctrlKey: false, altKey: false }), false)
})

test('hover text is concise, localized, and state-specific', () => {
  browserStorage()
  Object.defineProperty(global, 'navigator', {
    value: { platform: 'MacIntel' }, configurable: true,
  })
  const plugin = createClientPlugin(React, { generate: async () => ({ ok: false }) })
  const store = plugin._testing.storeFor('s1')
  assert.equal(plugin._testing.tooltipText(store, true), '生成下一句（⌘⇧Space）')
  store.phase = 'loading'
  assert.equal(plugin._testing.tooltipText(store, true), '正在生成…')
  store.phase = 'ready'
  store.candidates = ['A']
  store.index = 0
  assert.equal(plugin._testing.tooltipText(store, true), '换一条（⌘⇧Space）')
  store.phase = 'error'
  assert.equal(plugin._testing.tooltipText(store, false), 'Generation failed. Click to retry')
})
