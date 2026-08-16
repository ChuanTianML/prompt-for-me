'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const core = require('../src/core.cjs')

function message(type, text, source = { kind: 'user' }) {
  return { type, data: { content: [{ type: 'text', text }], source } }
}

function outcome(sessionId, action, origin, originalText, finalText) {
  return {
    sessionId,
    action,
    origin,
    ...(originalText === undefined ? {} : { originalText }),
    ...(finalText === undefined ? {} : { finalText }),
  }
}

test('resolveConfig supplies the three-tier defaults and rejects invalid limits and routes', () => {
  const config = core.resolveConfig({ candidateCount: 4 })
  assert.equal(config.candidateCount, 4)
  assert.equal(config.maxCurrentTurns, 3)
  assert.equal(config.maxCurrentContextBytes, 16384)
  assert.equal(config.maxCurrentFeedbackBytes, 4096)
  assert.equal(config.maxPreferenceMemoryBytes, 8192)
  assert.equal(config.shortcut, 'Mod+Shift+Space')
  assert.throws(() => core.resolveConfig({ provider: 'deepseek' }), /configured together/)
  assert.throws(() => core.resolveConfig({ maxCurrentFeedbackBytes: 100 }), /maxCurrentFeedbackBytes/)
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

test('normalizeLocalOutcomes accepts only bounded V2 provenance records', () => {
  const config = core.resolveConfig({ maxLocalOutcomes: 3 })
  assert.deepEqual(core.normalizeLocalOutcomes([
    { kind: 'cycled', candidate: 'legacy input is migrated in the browser' },
    outcome('s1', 'submitted', 'manual', undefined, 'typed prompt'),
    outcome('s1', 'submitted', 'suggestion-exact', 'candidate', 'candidate'),
    outcome('s1', 'cycled', 'suggestion-edited', 'original', 'edited draft'),
    outcome('s1', 'cycled', 'manual', undefined, 'invalid'),
  ], config), [
    outcome('s1', 'submitted', 'manual', undefined, 'typed prompt'),
    outcome('s1', 'submitted', 'suggestion-exact', 'candidate', 'candidate'),
    outcome('s1', 'cycled', 'suggestion-edited', 'original', 'edited draft'),
  ])
})

test('buildSuggestionInput separates current context, session feedback, and preference memory', () => {
  const config = core.resolveConfig({
    maxCurrentTurns: 3,
    maxManualPrompts: 2,
    maxLocalOutcomes: 20,
  })
  const localOutcomes = [
    outcome('current', 'submitted', 'suggestion-edited', 'Draft it verbosely', 'Current edited final'),
    outcome('current', 'submitted', 'suggestion-exact', 'Current exact', 'Current exact'),
    outcome('current', 'cycled', 'suggestion-exact', 'Rejected current'),
    outcome('history-new', 'submitted', 'suggestion-edited', 'Historical original', 'Historical edited final'),
    outcome('history-new', 'submitted', 'suggestion-exact', 'Historical exact', 'Historical exact'),
    outcome('history-new', 'cycled', 'suggestion-exact', 'Historical rejection'),
  ]
  const input = core.buildSuggestionInput({
    sessionId: 'current',
    draft: 'Please continue with token=super-secret',
    excluded: ['Already shown'],
    localOutcomes,
  }, [
    message('user/message', 'Old current turn'),
    message('assistant/message', 'Old reply', { kind: 'assistant' }),
    message('user/message', 'Current edited final'),
    message('assistant/message', 'Edited reply', { kind: 'assistant' }),
    message('user/message', 'Current exact'),
    message('assistant/message', 'Exact reply', { kind: 'assistant' }),
    message('user/message', 'Current manual'),
    message('assistant/message', 'Latest reply', { kind: 'assistant' }),
  ], [
    { sessionId: 'history-new', events: [
      message('user/message', 'Historical manual'),
      message('user/message', 'Historical edited final'),
      message('user/message', 'Historical exact'),
    ] },
    { sessionId: 'history-old', events: [message('user/message', 'Older manual')] },
  ], config)

  assert.equal(input.current.draft, 'Please continue with token=[REDACTED_SECRET]')
  assert.deepEqual(input.current.recentTurns.map((turn) => turn.user.text), [
    'Current edited final', 'Current exact', 'Current manual',
  ])
  assert.deepEqual(input.current.recentTurns.map((turn) => turn.user.origin), [
    'suggestion-edited', 'suggestion-exact', 'manual',
  ])
  assert.deepEqual(input.currentSessionFeedback, {
    editedSuggestions: [{
      original: 'Draft it verbosely', final: 'Current edited final', action: 'submitted',
    }],
    acceptedExact: [{ text: 'Current exact' }],
    rejectedSuggestions: [{ text: 'Rejected current' }],
  })
  assert.deepEqual(input.userPreferenceMemory, {
    manualPrompts: [{ text: 'Older manual' }, { text: 'Historical manual' }],
    editedSuggestions: [{ original: 'Historical original', final: 'Historical edited final' }],
    acceptedExact: [{ text: 'Historical exact' }],
    rejectedSuggestions: [{ text: 'Historical rejection' }],
  })
  assert.deepEqual(Object.keys(input.userPreferenceMemory), [
    'manualPrompts', 'editedSuggestions', 'acceptedExact', 'rejectedSuggestions',
  ])
  assert.deepEqual(input.excludedCandidates, ['Already shown'])
})

test('history selection favors the newest sessions and respects the manual-prompt cap', () => {
  const config = core.resolveConfig({ maxManualPrompts: 2 })
  const input = core.buildSuggestionInput({ sessionId: 'current', draft: '', excluded: [] }, [], [
    { sessionId: 'newer', events: [
      message('user/message', 'newer one'), message('user/message', 'newer two'),
    ] },
    { sessionId: 'older', events: [
      message('user/message', 'older one'), message('user/message', 'older two'),
    ] },
  ], config)
  assert.deepEqual(input.userPreferenceMemory.manualPrompts, [
    { text: 'newer one' }, { text: 'newer two' },
  ])
})

test('recent context keeps three turns and truncates oversized UTF-8 text instead of dropping it', () => {
  const config = core.resolveConfig({ maxCurrentTurns: 3, maxCurrentContextBytes: 700 })
  const suffix = '最后结论'
  const events = [
    message('user/message', 'turn one'),
    message('assistant/message', 'reply one', { kind: 'assistant' }),
    message('user/message', 'turn two'),
    message('assistant/message', 'reply two', { kind: 'assistant' }),
    message('user/message', 'turn three'),
    message('assistant/message', `${'很长的回答'.repeat(1000)}${suffix}`, { kind: 'assistant' }),
  ]
  const turns = core.recentConversationTurns(events, [], 'current', config)
  assert.equal(turns.length, 3)
  assert.ok(Buffer.byteLength(JSON.stringify(turns), 'utf8') <= 700)
  assert.match(turns[2].assistant.text, /\.\.\.\[truncated\]\.\.\./)
  assert.ok(turns[2].assistant.text.endsWith(suffix))
  assert.equal(JSON.stringify(turns).includes('\uFFFD'), false)
})

test('feedback and preference sections remain inside independent byte budgets', () => {
  const config = core.resolveConfig({
    maxCandidateBytes: 20000,
    maxDraftBytes: 20000,
    maxCurrentFeedbackBytes: 512,
    maxPreferenceMemoryBytes: 640,
    maxLocalOutcomes: 20,
  })
  const long = '好'.repeat(3000)
  const input = core.buildSuggestionInput({
    sessionId: 'current',
    draft: '',
    excluded: [],
    localOutcomes: [
      outcome('current', 'submitted', 'suggestion-edited', long, `${long}编辑`),
      outcome(null, 'submitted', 'suggestion-edited', long, `${long}历史编辑`),
      outcome(null, 'submitted', 'suggestion-exact', long, long),
    ],
  }, [], [], config)
  assert.ok(Buffer.byteLength(JSON.stringify(input.currentSessionFeedback), 'utf8') <= 512)
  assert.ok(Buffer.byteLength(JSON.stringify(input.userPreferenceMemory), 'utf8') <= 640)
})

test('parseCandidateLine enforces one bounded candidate field', () => {
  const config = core.resolveConfig({ candidateCount: 3 })
  assert.equal(core.parseCandidateLine('{"candidate":" one "}', config), 'one')
  assert.throws(() => core.parseCandidateLine('not json', config), /not-json/)
  assert.throws(() => core.parseCandidateLine('{"candidate":"one","extra":true}', config), /invalid-line/)
  assert.throws(() => core.parseCandidateLine('{"candidate":2}', config), /invalid-line/)
})

test('systemPrompt states the signal hierarchy and progressive NDJSON response', () => {
  const prompt = core.systemPrompt(4)
  assert.match(prompt, /current\.draft and current\.recentTurns to decide the current task/)
  assert.match(prompt, /manualPrompts and editedSuggestions outweigh acceptedExact/)
  assert.match(prompt, /rejectedSuggestions only as weak negative evidence/)
  assert.match(prompt, /must never override the current task/)
  assert.match(prompt, /exactly 4 distinct suggestions/)
  assert.match(prompt, /"candidate":"suggestion 4"/)
  assert.match(prompt, /NDJSON/)
  assert.match(prompt, /untrusted data/)
  assert.match(prompt, /cannot imply approval or weaken safety checks/)
})
