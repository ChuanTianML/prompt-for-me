'use strict'

const { randomUUID } = require('node:crypto')
const {
  buildSuggestionInput,
  parseCandidateLine,
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

async function collectCandidates(stream, abortController, config, excluded, onCandidate) {
  let buffered = ''
  let outputBytes = 0
  let sawDelta = false
  let finish
  let toolCall = false
  const blocked = new Set(excluded.map((value) => value.trim()))
  const candidates = []

  async function acceptLine(line) {
    if (line.trim() === '' || candidates.length >= config.candidateCount) return
    const candidate = parseCandidateLine(line, config)
    if (blocked.has(candidate) || candidates.includes(candidate)) return
    candidates.push(candidate)
    await onCandidate(candidate, candidates.length - 1)
  }

  async function acceptText(text, flush = false) {
    outputBytes += utf8Bytes(text)
    if (outputBytes > config.maxCandidateBytes * config.candidateCount * 4) {
      abortController.abort()
      throw new Error('model-output-too-large')
    }
    buffered += text
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, '')
      buffered = buffered.slice(newline + 1)
      await acceptLine(line)
      newline = buffered.indexOf('\n')
    }
    if (flush && buffered.trim() !== '') {
      await acceptLine(buffered)
      buffered = ''
    }
  }

  try {
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        sawDelta = true
        await acceptText(chunk.text)
      } else if (!sawDelta && chunk.type === 'block-end'
        && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
        await acceptText(chunk.block.text)
      } else if (chunk.type === 'tool-call' || chunk.type === 'tool-call-delta'
        || (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call')) {
        toolCall = true
      } else if (chunk.type === 'finish') {
        finish = chunk.reason
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
  await acceptText('', true)
  if (toolCall) throw new Error('model-returned-tool-call')
  if (finish && finish.kind && finish.kind !== 'stop') {
    throw new Error(`model-finished-${finish.kind}`)
  }
  if (candidates.length < config.candidateCount) throw new Error('model-output-too-few-candidates')
  return candidates
}

function createGenerateStream(ctx, config) {
  return async function generate(args, onCandidate, requestSignal) {
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
    const controller = new AbortController()
    const abortForRequest = () => controller.abort()
    if (requestSignal) requestSignal.addEventListener('abort', abortForRequest, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, config.timeoutMs)
    try {
      const history = await historicalEvents(ctx, args.sessionId, config)
      const input = buildSuggestionInput(args, session.events, history, config)
      const stream = llm.stream({
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
      const candidates = await collectCandidates(
        stream,
        controller,
        config,
        input.excludedCandidates,
        async (candidate, index) => {
          if (requestSignal && requestSignal.aborted) throw new Error('client-disconnected')
          await onCandidate(candidate, index)
        },
      )
      return { ok: true, batchId: randomUUID(), candidates }
    } catch (error) {
      const code = requestSignal && requestSignal.aborted
        ? 'CLIENT_DISCONNECTED'
        : timedOut ? 'TIMEOUT' : 'GENERATION_FAILED'
      return {
        ok: false,
        code,
        message: code === 'CLIENT_DISCONNECTED'
          ? 'The browser stopped this suggestion request.'
          : code === 'TIMEOUT'
          ? 'Prompt for Me timed out.'
          : 'Prompt for Me could not generate a valid suggestion batch.',
      }
    } finally {
      clearTimeout(timer)
      if (requestSignal) requestSignal.removeEventListener('abort', abortForRequest)
    }
  }
}

function createGenerateHandler(ctx, config) {
  const generate = createGenerateStream(ctx, config)
  return async (args) => generate(args, async () => {})
}

function writeNdjson(response, event) {
  if (response.destroyed || response.writableEnded) return false
  response.write(`${JSON.stringify(event)}\n`)
  return true
}

function registerRoute(ctx, config) {
  const webServer = service(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('prompt-for-me: webServer service is unavailable')
  }
  const generate = createGenerateStream(ctx, config)
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
      response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      const requestController = new AbortController()
      const abortRequest = () => {
        if (!response.writableEnded) requestController.abort()
      }
      response.on('close', abortRequest)
      try {
        const result = await generate(body.args, async (candidate, index) => {
          if (!writeNdjson(response, { type: 'candidate', index, candidate })) {
            requestController.abort()
          }
        }, requestController.signal)
        if (!response.destroyed && !response.writableEnded) {
          writeNdjson(response, result.ok
            ? { type: 'done', batchId: result.batchId, count: result.candidates.length }
            : { type: 'error', code: result.code, message: result.message })
          response.end()
        }
      } finally {
        response.off('close', abortRequest)
      }
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
    collectCandidates,
    createGenerateHandler,
    createGenerateStream,
    historicalEvents,
    readJson,
    resolveRoute,
    sameOrigin,
  },
}
