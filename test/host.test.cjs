'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const host = require('../src/index.cjs')
const { resolveConfig } = require('../src/core.cjs')

function userEvent(text) {
  return { type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }
}

function candidateLines(...candidates) {
  return candidates.map(candidate => JSON.stringify({ candidate })).join('\n')
}

function contextWith(streamFactory) {
  const requests = []
  const session = {
    events: [userEvent('Fix the concurrency bug and report focused tests.')],
    requestHeader: () => ({ config: { provider: 'session-provider', model: 'session-model' } }),
  }
  const services = {
    sessions: { get: (id) => id === 'session-1' ? session : undefined },
    llm: {
      stream(options) {
        requests.push(options)
        return streamFactory(options)
      },
    },
    sessionQuery: {
      listSessions: async () => [
        { header: { id: 'session-1' } },
        { header: { id: 'history-1' } },
      ],
      readSession: async () => ({ events: [userEvent('Keep changes small and run focused tests.')] }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default', model: 'default' }) },
  }
  return { ctx: { get: (name) => services[name] }, requests }
}

test('generate reuses the session route and sends bounded contextual JSON without tools', async () => {
  const { ctx, requests } = contextWith(async function * () {
    yield { type: 'text-delta', text: `${candidateLines('A', 'B', 'C')}\n` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const generate = host._testing.createGenerateHandler(ctx, resolveConfig({}))
  const result = await generate({
    sessionId: 'session-1',
    draft: 'Please inspect this.',
    excluded: [],
    localOutcomes: [{ kind: 'cycled', candidate: 'Old suggestion' }],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.candidates, ['A', 'B', 'C'])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].provider, 'session-provider')
  assert.equal(requests[0].model, 'session-model')
  assert.equal(requests[0].tools, undefined)
  const framed = JSON.parse(requests[0].messages[0].content[0].text)
  assert.equal(framed.currentDraft, 'Please inspect this.')
  assert.deepEqual(framed.previousPrompts, [{ text: 'Keep changes small and run focused tests.' }])
  assert.deepEqual(framed.previousSuggestionOutcomes, [{ kind: 'cycled', candidate: 'Old suggestion' }])
})

test('generate honors a fixed route override', async () => {
  const { ctx, requests } = contextWith(async function * () {
    yield { type: 'text-delta', text: candidateLines('A', 'B', 'C') }
  })
  const config = resolveConfig({ provider: 'fixed', model: 'fixed-model' })
  const result = await host._testing.createGenerateHandler(ctx, config)({
    sessionId: 'session-1', draft: '', excluded: [], localOutcomes: [],
  })
  assert.equal(result.ok, true)
  assert.equal(requests[0].provider, 'fixed')
  assert.equal(requests[0].model, 'fixed-model')
})

test('generate publishes the first complete candidate before the remaining batch', async () => {
  let releaseRemaining
  const remaining = new Promise((resolve) => { releaseRemaining = resolve })
  const { ctx } = contextWith(async function * () {
    yield { type: 'text-delta', text: `${candidateLines('A')}\n` }
    await remaining
    yield { type: 'text-delta', text: candidateLines('B', 'C') }
  })
  const generate = host._testing.createGenerateStream(ctx, resolveConfig({}))
  const seen = []
  let signalFirst
  const first = new Promise((resolve) => { signalFirst = resolve })
  const pending = generate({
    sessionId: 'session-1', draft: '', excluded: [], localOutcomes: [],
  }, async (candidate) => {
    seen.push(candidate)
    if (seen.length === 1) signalFirst()
  })

  await first
  assert.deepEqual(seen, ['A'])
  releaseRemaining()
  const result = await pending
  assert.equal(result.ok, true)
  assert.deepEqual(seen, ['A', 'B', 'C'])
})

test('generate rejects stale sessions and invalid model output with user-safe errors', async () => {
  const { ctx } = contextWith(async function * () {
    yield { type: 'text-delta', text: 'not-json' }
  })
  const generate = host._testing.createGenerateHandler(ctx, resolveConfig({}))
  assert.deepEqual(await generate({ sessionId: 'gone', draft: '', excluded: [] }), {
    ok: false,
    code: 'SESSION_NOT_LIVE',
    message: 'This session is no longer active.',
  })
  assert.deepEqual(await generate({ sessionId: 'session-1', draft: '', excluded: [] }), {
    ok: false,
    code: 'GENERATION_FAILED',
    message: 'Prompt for Me could not generate a valid suggestion batch.',
  })
})

test('generate reports a locally enforced model timeout', async () => {
  const { ctx } = contextWith((options) => ({
    [Symbol.asyncIterator]() { return this },
    next() {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted by timeout')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
    return: async () => ({ done: true }),
  }))
  const generate = host._testing.createGenerateHandler(ctx, resolveConfig({ timeoutMs: 1 }))
  assert.deepEqual(await generate({ sessionId: 'session-1', draft: '', excluded: [] }), {
    ok: false,
    code: 'TIMEOUT',
    message: 'Prompt for Me timed out.',
  })
})

test('collectCandidates rejects tool calls and non-stop finishes', async () => {
  const controller = new AbortController()
  const config = resolveConfig({})
  await assert.rejects(() => host._testing.collectCandidates((async function * () {
    yield { type: 'tool-call' }
  })(), controller, config, [], async () => {}), /tool-call/)
  await assert.rejects(() => host._testing.collectCandidates((async function * () {
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })(), controller, config, [], async () => {}), /max-tokens/)
})

test('sameOrigin accepts same-host and non-browser requests and rejects cross-site origins', () => {
  assert.equal(host._testing.sameOrigin({ headers: { host: '127.0.0.1:3080' } }), true)
  assert.equal(host._testing.sameOrigin({ headers: {
    host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080',
  } }), true)
  assert.equal(host._testing.sameOrigin({ headers: {
    host: '127.0.0.1:3080', origin: 'https://evil.example',
  } }), false)
})

test('readJson rejects malformed and oversized bodies', async () => {
  const malformed = new EventEmitter()
  malformed.headers = {}
  const malformedResult = host._testing.readJson(malformed)
  malformed.emit('data', Buffer.from('{'))
  malformed.emit('end')
  await assert.rejects(malformedResult, /invalid-json/)

  const oversized = new EventEmitter()
  oversized.headers = {}
  oversized.destroy = () => {}
  const oversizedResult = host._testing.readJson(oversized)
  oversized.emit('data', Buffer.alloc(256 * 1024 + 1))
  await assert.rejects(oversizedResult, /request-too-large/)
})
