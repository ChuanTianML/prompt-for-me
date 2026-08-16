'use strict'

const { randomUUID } = require('node:crypto')
const {
  buildSuggestionInput,
  parseCandidates,
  resolveConfig,
  systemPrompt,
  utf8Bytes,
} = require('./core.cjs')

const RPC_PATH = '/dsh-prompt-for-me/rpc'
const MAX_RPC_BYTES = 256 * 1024

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function sameOrigin(request) {
  const origin = request.headers && request.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = request.headers && request.headers.host
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_RPC_BYTES) {
        reject(new Error('request-too-large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    request.on('error', reject)
  })
}

function service(ctx, name) {
  return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
}

function resolveRoute(ctx, session, config) {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  let selected
  try {
    selected = session && typeof session.requestHeader === 'function'
      ? session.requestHeader()?.config
      : undefined
  } catch {
    selected = undefined
  }
  if (!selected) {
    const defaults = service(ctx, 'agentDefaultModel')
    if (defaults && typeof defaults.currentSelection === 'function') selected = defaults.currentSelection()
  }
  return selected && typeof selected.provider === 'string' && selected.provider !== ''
    && typeof selected.model === 'string' && selected.model !== ''
    ? { provider: selected.provider, model: selected.model }
    : undefined
}

async function historicalEvents(ctx, sessionId, config) {
  const query = service(ctx, 'sessionQuery')
  if (!query || config.maxHistorySessions === 0
    || typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') return []
  try {
    const records = await query.listSessions()
    const lists = []
    for (const record of Array.isArray(records) ? records : []) {
      const id = record && record.header && record.header.id
      if (typeof id !== 'string' || id === sessionId) continue
      try {
        const snapshot = await query.readSession(id)
        if (snapshot && Array.isArray(snapshot.events)) lists.push(snapshot.events)
      } catch {
        // One unreadable historical session should not block current suggestions.
      }
      if (lists.length >= config.maxHistorySessions) break
    }
    return lists
  } catch {
    return []
  }
}

async function collectText(stream, abortController, maxBytes) {
  let text = ''
  let sawDelta = false
  let finish
  let toolCall = false
  try {
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        sawDelta = true
        text += chunk.text
      } else if (!sawDelta && chunk.type === 'block-end'
        && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
        text += chunk.block.text
      } else if (chunk.type === 'tool-call' || chunk.type === 'tool-call-delta'
        || (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call')) {
        toolCall = true
      } else if (chunk.type === 'finish') {
        finish = chunk.reason
      }
      if (utf8Bytes(text) > maxBytes) {
        abortController.abort()
        throw new Error('model-output-too-large')
      }
    }
  } finally {
    if (abortController.signal.aborted && stream && typeof stream.return === 'function') {
      try {
        await stream.return()
      } catch {
        // The abort already owns the failure.
      }
    }
  }
  if (toolCall) throw new Error('model-returned-tool-call')
  if (finish && finish.kind && finish.kind !== 'stop') {
    throw new Error(`model-finished-${finish.kind}`)
  }
  return text
}

function createGenerateHandler(ctx, config) {
  return async function generate(args) {
    if (!args || typeof args !== 'object' || typeof args.sessionId !== 'string'
      || typeof args.draft !== 'string' || !Array.isArray(args.excluded)) {
      return { ok: false, code: 'BAD_REQUEST', message: 'sessionId, draft, and excluded are required' }
    }
    if (utf8Bytes(args.draft) > config.maxDraftBytes) {
      return { ok: false, code: 'DRAFT_TOO_LARGE', message: 'The composer draft is too large.' }
    }
    const sessions = service(ctx, 'sessions')
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(args.sessionId) : undefined
    if (!session) return { ok: false, code: 'SESSION_NOT_LIVE', message: 'This session is no longer active.' }
    const llm = service(ctx, 'llm')
    if (!llm || typeof llm.stream !== 'function') {
      return { ok: false, code: 'NO_LLM', message: 'No Harness model route is available.' }
    }
    const route = resolveRoute(ctx, session, config)
    if (!route) return { ok: false, code: 'NO_MODEL_ROUTE', message: 'No model is selected for this session.' }

    let timedOut = false
    try {
      const history = await historicalEvents(ctx, args.sessionId, config)
      const input = buildSuggestionInput(args, session.events, history, config)
      const controller = new AbortController()
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, config.timeoutMs)
      let stream
      try {
        stream = llm.stream({
          provider: route.provider,
          model: route.model,
          sessionId: args.sessionId,
          maxTokens: config.maxOutputTokens,
          system: systemPrompt(config.candidateCount),
          messages: [{
            id: `prompt-for-me-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text: JSON.stringify(input) }],
            source: { kind: 'plugin', plugin: 'dsh-prompt-for-me' },
          }],
          signal: controller.signal,
        })
        const text = await collectText(
          stream,
          controller,
          config.maxCandidateBytes * config.candidateCount * 4,
        )
        const candidates = parseCandidates(text, config, input.excludedCandidates)
        return { ok: true, batchId: randomUUID(), candidates }
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      const code = timedOut ? 'TIMEOUT' : 'GENERATION_FAILED'
      return {
        ok: false,
        code,
        message: code === 'TIMEOUT'
          ? 'Prompt for Me timed out.'
          : 'Prompt for Me could not generate a valid suggestion batch.',
      }
    }
  }
}

function registerRoute(ctx, config) {
  const webServer = service(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('prompt-for-me: webServer service is unavailable')
  }
  const generate = createGenerateHandler(ctx, config)
  return webServer.register({
    kind: 'exact',
    path: RPC_PATH,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        json(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' })
        return
      }
      if (!sameOrigin(request)) {
        json(response, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED' })
        return
      }
      let body
      try {
        body = await readJson(request)
      } catch (error) {
        json(response, error && error.message === 'request-too-large' ? 413 : 400, {
          ok: false,
          code: error && error.message === 'request-too-large' ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON',
        })
        return
      }
      if (body.method === 'configuration') {
        json(response, 200, {
          ok: true,
          shortcut: config.shortcut,
          maxLocalOutcomes: config.maxLocalOutcomes,
        })
        return
      }
      if (body.method !== 'generate') {
        json(response, 404, { ok: false, code: 'UNKNOWN_METHOD' })
        return
      }
      json(response, 200, await generate(body.args))
    },
  })
}

module.exports = {
  name: 'dsh-prompt-for-me',
  apply(ctx, inputConfig) {
    const config = resolveConfig(inputConfig)
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (hostCtx) => {
        hostCtx.effect(() => registerRoute(hostCtx, config), 'dsh-prompt-for-me: rpc route')
      })
      return
    }
    return registerRoute(ctx, config)
  },
  _testing: {
    collectText,
    createGenerateHandler,
    historicalEvents,
    readJson,
    resolveRoute,
    sameOrigin,
  },
}
