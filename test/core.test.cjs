'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const core = require('../src/core.cjs')

function message(type, text, source = { kind: 'user' }) {
  return { type, data: { content: [{ type: 'text', text }], source } }
}

test('resolveConfig supplies defaults and rejects a half-configured route', () => {
  const config = core.resolveConfig({ candidateCount: 4 })
  assert.equal(config.candidateCount, 4)
  assert.equal(config.shortcut, 'Mod+Shift+Space')
  assert.throws(() => core.resolveConfig({ provider: 'deepseek' }), /configured together/)
  assert.throws(() => core.resolveConfig({ timeoutMs: 0 }), /timeoutMs/)
})

test('redactSecrets removes common credential forms', () => {
  assert.equal(
    core.redactSecrets('sk-abcdefghijklmnop token=secret-value Bearer abcdefghijklmnop'),
    '[REDACTED_SECRET] token=[REDACTED_SECRET] Bearer [REDACTED_SECRET]',
  )
})

test('message extraction keeps only visible text blocks', () => {
  const event = {
    content: [
      { type: 'text', text: 'first' },
      { type: 'image', data: 'ignored' },
      { type: 'text', text: 'second' },
    ],
  }
  assert.equal(core.messageText(event), 'first\nsecond')
})

test('takeRecentWithinBudget prefers the newest items', () => {
  const items = [{ text: 'old' }, { text: 'middle' }, { text: 'new' }]
  const maxBytes = Buffer.byteLength(JSON.stringify(items.slice(1)), 'utf8')
  assert.deepEqual(core.takeRecentWithinBudget(items, 10, maxBytes), items.slice(1))
})

test('buildSuggestionInput bounds, redacts, and separates current and historical messages', () => {
  const config = core.resolveConfig({ maxHistoryMessages: 2, maxLocalOutcomes: 2 })
  const input = core.buildSuggestionInput({
    draft: 'Please continue with token=super-secret',
    excluded: ['Already shown'],
    localOutcomes: [
      { kind: 'cycled', candidate: 'One' },
      { kind: 'edited', candidate: 'Two', resultingText: 'Two, but shorter' },
      { kind: 'bad' },
    ],
  }, [
    message('user/message', 'Current user prompt'),
    message('assistant/message', 'Current assistant reply', { kind: 'assistant' }),
  ], [[
    message('user/message', 'Old one'),
    message('user/message', 'Old two'),
    message('user/message', 'Old three'),
  ]], config)

  assert.equal(input.currentDraft, 'Please continue with token=[REDACTED_SECRET]')
  assert.deepEqual(input.currentConversation.map((entry) => entry.role), ['user', 'assistant'])
  assert.deepEqual(input.previousPrompts, [{ text: 'Old two' }, { text: 'Old three' }])
  assert.deepEqual(input.previousSuggestionOutcomes, [
    { kind: 'cycled', candidate: 'One' },
    { kind: 'edited', candidate: 'Two', resultingText: 'Two, but shorter' },
  ])
  assert.deepEqual(input.excludedCandidates, ['Already shown'])
})

test('history selection favors newest sessions from SessionQuery newest-first records', () => {
  const config = core.resolveConfig({ maxHistoryMessages: 2 })
  const input = core.buildSuggestionInput({ draft: '', excluded: [] }, [], [
    [message('user/message', 'newer one'), message('user/message', 'newer two')],
    [message('user/message', 'older one'), message('user/message', 'older two')],
  ], config)
  assert.deepEqual(input.previousPrompts, [{ text: 'newer one' }, { text: 'newer two' }])
})

test('parseCandidates enforces strict JSON, distinct values, exclusions, and dynamic count', () => {
  const config = core.resolveConfig({ candidateCount: 3 })
  assert.deepEqual(core.parseCandidates(JSON.stringify({
    candidates: [' one ', 'two', 'three', 'four'],
  }), config, ['four']), ['one', 'two', 'three'])
  assert.throws(() => core.parseCandidates('not json', config, []), /not-json/)
  assert.throws(() => core.parseCandidates(JSON.stringify({ candidates: ['one', 'one'] }), config, []), /too-few/)
  assert.throws(() => core.parseCandidates(JSON.stringify({ candidates: ['one', 2, 'three'] }), config, []), /non-string/)
})

test('systemPrompt asks for the configured candidate count and treats history as data', () => {
  const prompt = core.systemPrompt(4)
  assert.match(prompt, /exactly 4 distinct suggestions/)
  assert.match(prompt, /"suggestion 4"/)
  assert.match(prompt, /untrusted data/)
  assert.match(prompt, /Do not weaken safety checks/)
})
