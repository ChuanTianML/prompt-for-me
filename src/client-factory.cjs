'use strict'

module.exports = function createClientPlugin(React, options) {
  const RPC_PATH = '/dsh-prompt-for-me/rpc'
  const STORAGE_KEY = 'dsh.prompt-for-me.outcomes.v2'
  const LEGACY_STORAGE_KEY = 'dsh.prompt-for-me.outcomes.v1'
  const TRIGGER_COALESCE_MS = 250
  const stores = new Map()
  const config = {
    shortcut: 'Mod+Shift+Space',
    maxCurrentCycleSkipped: 10,
    maxCurrentCycleSkippedBytes: 16384,
    maxLocalOutcomes: 50,
    maxLocalOutcomesBytes: 131072,
    automatic: Boolean(options && options.automatic === true),
  }
  let automaticPolicyReady = Boolean(options && typeof options.automatic === 'boolean')
  let configurationRequest = null
  const now = options && typeof options.now === 'function'
    ? options.now
    : () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now())
  const rpc = options && typeof options.rpc === 'function'
    ? options.rpc
    : async (method, args) => {
        const response = await window.fetch(RPC_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, args: args || {} }),
        })
        return response.json()
      }
  const streamGenerate = options && typeof options.generate === 'function'
    ? options.generate
    : async (args, onCandidate, signal) => {
        const response = await window.fetch(RPC_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'generate', args }),
          signal,
        })
        if (!response.ok) {
          let failure
          try {
            failure = await response.json()
          } catch {
            failure = undefined
          }
          return {
            ok: false,
            message: failure && typeof failure.message === 'string'
              ? failure.message
              : 'Prompt for Me could not reach the Harness Host.',
          }
        }
        if (!response.body || typeof response.body.getReader !== 'function') {
          return { ok: false, message: 'Prompt for Me did not receive a suggestion stream.' }
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffered = ''
        let completion

        async function acceptLine(line) {
          if (line.trim() === '') return
          const event = JSON.parse(line)
          if (event && event.type === 'candidate' && typeof event.candidate === 'string') {
            await onCandidate(event.candidate)
          } else if (event && event.type === 'done') {
            completion = { ok: true, requestId: event.requestId }
          } else if (event && event.type === 'error') {
            completion = {
              ok: false,
              message: typeof event.message === 'string'
                ? event.message
                : 'Prompt for Me could not generate suggestions.',
            }
          }
        }

        while (true) {
          const chunk = await reader.read()
          buffered += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done })
          let newline = buffered.indexOf('\n')
          while (newline >= 0) {
            const line = buffered.slice(0, newline).replace(/\r$/, '')
            buffered = buffered.slice(newline + 1)
            await acceptLine(line)
            newline = buffered.indexOf('\n')
          }
          if (chunk.done) break
        }
        if (buffered.trim() !== '') await acceptLine(buffered)
        return completion || { ok: false, message: 'Prompt for Me suggestion stream ended early.' }
      }

  function createSettingsController() {
    let snapshot = {
      status: 'loading', value: undefined, revision: 0, writable: false,
    }
    let generation = 0
    let tail = Promise.resolve()
    const listeners = new Set()
    const publish = (next) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    }
    const accept = (result, expectedGeneration) => {
      if (expectedGeneration !== generation || !result || result.ok !== true) return false
      publish({
        status: 'ready',
        value: normalizeUserSettings(result.settings),
        revision: snapshot.revision + 1,
        writable: result.writable === true,
      })
      return true
    }
    const load = () => {
      const expectedGeneration = ++generation
      const task = tail.then(async () => {
        try {
          const result = await rpc('settings', {})
          if (!accept(result, expectedGeneration) && expectedGeneration === generation
            && snapshot.status !== 'ready') {
            publish({ ...snapshot, status: 'unavailable', writable: false })
          }
        } catch {
          if (expectedGeneration === generation && snapshot.status !== 'ready') {
            publish({ ...snapshot, status: 'unavailable', writable: false })
          }
        }
      })
      tail = task.catch(() => {})
      return task
    }
    const replace = (settings) => {
      const expectedGeneration = ++generation
      const task = tail.then(async () => {
        let result
        try {
          result = await rpc('update-settings', { settings })
        } catch {
          result = undefined
        }
        if (!accept(result, expectedGeneration) && expectedGeneration === generation) {
          const refreshGeneration = ++generation
          try {
            accept(await rpc('settings', {}), refreshGeneration)
          } catch {
            // The last good snapshot remains usable and the card reports that the save did not land.
          }
        }
      })
      tail = task.catch(() => {})
      return task
    }
    return {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      load,
      replace,
    }
  }

  function storeFor(sessionId) {
    let store = stores.get(sessionId)
    if (!store) {
      store = {
        phase: 'idle',
        error: null,
        candidate: undefined,
        candidateSkipped: false,
        presentation: 'none',
        suggestionId: undefined,
        currentCycleSkipped: [],
        sourceDraft: '',
        requestDraft: '',
        observedDraft: '',
        observedPhase: null,
        requestSeq: 0,
        pending: false,
        generationKind: null,
        awaitingDraftAck: null,
        lastAcceptedTriggerAt: null,
        controller: null,
        observedSuggestionId: undefined,
        observedTurnSeeded: false,
        seenTurnEndSeq: null,
        pendingAutomaticTrigger: undefined,
        automaticObservation: undefined,
        listeners: new Set(),
      }
      stores.set(sessionId, store)
    }
    return store
  }

  function emit(store) {
    for (const listener of [...store.listeners]) listener()
  }

  function migrateLegacyOutcome(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.candidate !== 'string'
      || raw.candidate === '') return undefined
    if (raw.kind === 'submitted-exact') {
      return {
        sessionId: null,
        action: 'submitted',
        origin: 'suggestion-exact',
        originalText: raw.candidate,
        finalText: raw.candidate,
        at: Number.isFinite(raw.at) ? raw.at : Date.now(),
      }
    }
    if (raw.kind === 'submitted-edited' && typeof raw.resultingText === 'string'
      && raw.resultingText !== '') {
      return {
        sessionId: null,
        action: 'submitted',
        origin: 'suggestion-edited',
        originalText: raw.candidate,
        finalText: raw.resultingText,
        at: Number.isFinite(raw.at) ? raw.at : Date.now(),
      }
    }
    if (raw.kind === 'cycled') {
      return {
        sessionId: null,
        action: 'cycled',
        origin: 'suggestion-exact',
        originalText: raw.candidate,
        at: Number.isFinite(raw.at) ? raw.at : Date.now(),
      }
    }
    if (raw.kind === 'edited' && typeof raw.resultingText === 'string'
      && raw.resultingText !== '') {
      return {
        sessionId: null,
        action: 'cycled',
        origin: 'suggestion-edited',
        originalText: raw.candidate,
        finalText: raw.resultingText,
        at: Number.isFinite(raw.at) ? raw.at : Date.now(),
      }
    }
    return undefined
  }

  function jsonBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  }

  function takeRecentWithinBudget(value, maxItems, maxBytes) {
    if (!Array.isArray(value) || maxItems === 0) return []
    const selected = []
    for (let index = value.length - 1; index >= 0 && selected.length < maxItems; index -= 1) {
      const candidate = [value[index], ...selected]
      if (jsonBytes(candidate) <= maxBytes) selected.unshift(value[index])
    }
    return selected
  }

  function boundedOutcomes(value) {
    return takeRecentWithinBudget(
      value,
      config.maxLocalOutcomes,
      config.maxLocalOutcomesBytes,
    )
  }

  function readOutcomes() {
    try {
      const current = window.localStorage.getItem(STORAGE_KEY)
      if (current !== null) {
        const parsed = JSON.parse(current)
        const bounded = boundedOutcomes(parsed)
        if (JSON.stringify(parsed) !== JSON.stringify(bounded)) {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bounded))
        }
        return bounded
      }
      const legacy = JSON.parse(window.localStorage.getItem(LEGACY_STORAGE_KEY) || '[]')
      const migrated = boundedOutcomes((Array.isArray(legacy) ? legacy : [])
        .map(migrateLegacyOutcome)
        .filter(Boolean))
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
      return migrated
    } catch {
      return []
    }
  }

  function recordOutcome(sessionId, outcome) {
    if (!outcome || typeof outcome !== 'object'
      || (outcome.action !== 'submitted' && outcome.action !== 'cycled')
      || (outcome.origin !== 'manual' && outcome.origin !== 'suggestion-exact'
        && outcome.origin !== 'suggestion-edited')) return
    const next = boundedOutcomes([...readOutcomes(), {
      sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
      action: outcome.action,
      origin: outcome.origin,
      ...(typeof outcome.originalText === 'string' && outcome.originalText !== ''
        ? { originalText: outcome.originalText }
        : {}),
      ...(typeof outcome.finalText === 'string' && outcome.finalText !== ''
        ? { finalText: outcome.finalText }
        : {}),
      at: Date.now(),
    }])
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Suggestion generation remains usable when local storage is unavailable.
    }
  }

  function activeCandidate(store) {
    return store.candidate
  }

  function setDraft(actions, text) {
    if (actions && typeof actions.setDraft === 'function') actions.setDraft(text)
  }

  function offerSuggestion(actions, suggestion) {
    if (!actions || typeof actions.offerSuggestion !== 'function') return false
    try {
      return actions.offerSuggestion(suggestion) === true
    } catch {
      return false
    }
  }

  function dismissSuggestion(actions, id) {
    if (!actions || typeof actions.dismissSuggestion !== 'function' || id === undefined) return false
    try {
      return actions.dismissSuggestion(id) === true
    } catch {
      return false
    }
  }

  function cancelPending(store) {
    if (store.controller) store.controller.abort()
    store.controller = null
    store.pending = false
    store.generationKind = null
    store.awaitingDraftAck = null
  }

  function showCandidate(sessionId, store, actions, candidate, kind) {
    store.candidate = candidate
    store.candidateSkipped = false
    store.phase = store.pending ? 'loading' : 'ready'
    store.error = null
    if (kind === 'automatic') {
      const suggestion = {
        id: `dsh-prompt-for-me:${sessionId}:${String(store.requestSeq)}`,
        text: candidate,
      }
      store.suggestionId = suggestion.id
      store.awaitingDraftAck = null
      store.presentation = offerSuggestion(actions, suggestion) ? 'ghost' : 'fallback'
    } else {
      store.suggestionId = undefined
      store.presentation = 'draft'
      store.awaitingDraftAck = {
        candidate,
        previousDraft: store.observedDraft,
      }
      setDraft(actions, candidate)
    }
    emit(store)
    return true
  }

  function clearCandidate(store, actions) {
    if (store.presentation === 'ghost') dismissSuggestion(actions, store.suggestionId)
    store.candidate = undefined
    store.candidateSkipped = false
    store.presentation = 'none'
    store.suggestionId = undefined
    store.awaitingDraftAck = null
  }

  function useFallback(store, actions) {
    const candidate = activeCandidate(store)
    if (candidate === undefined || store.presentation !== 'fallback') return false
    store.presentation = 'draft'
    store.awaitingDraftAck = { candidate, previousDraft: store.observedDraft }
    setDraft(actions, candidate)
    emit(store)
    return true
  }

  function rememberSkipped(store, candidate) {
    if (!store.currentCycleSkipped.includes(candidate)) store.currentCycleSkipped.push(candidate)
    store.currentCycleSkipped = takeRecentWithinBudget(
      store.currentCycleSkipped,
      config.maxCurrentCycleSkipped,
      config.maxCurrentCycleSkippedBytes,
    )
  }

  async function requestSuggestion(sessionId, draft, actions, store, kind, triggerKind) {
    cancelPending(store)
    store.phase = 'loading'
    store.error = null
    store.requestDraft = draft
    store.pending = true
    store.generationKind = kind
    store.requestSeq += 1
    const seq = store.requestSeq
    const controller = new AbortController()
    store.controller = controller
    emit(store)
    let result
    try {
      result = await streamGenerate({
        sessionId,
        draft: store.sourceDraft,
        trigger: triggerKind,
        currentCycleSkipped: [...store.currentCycleSkipped],
        localOutcomes: readOutcomes(),
      }, async (candidate) => {
        if (seq !== store.requestSeq || controller.signal.aborted
          || typeof candidate !== 'string' || candidate.trim() === '') return
        if (store.observedDraft === draft) {
          showCandidate(sessionId, store, actions, candidate.trim(), kind)
        }
      }, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) return
      result = { ok: false, message: 'Prompt for Me could not reach the Harness Host.' }
    }
    if (seq !== store.requestSeq || controller.signal.aborted) return
    store.pending = false
    store.generationKind = null
    store.controller = null
    if (!result || result.ok !== true || activeCandidate(store) === undefined
      || store.candidateSkipped) {
      if (activeCandidate(store) !== undefined) clearCandidate(store, actions)
      store.phase = kind === 'automatic' ? 'idle' : 'error'
      store.error = kind === 'automatic'
        ? null
        : result && typeof result.message === 'string'
          ? result.message
          : 'Prompt for Me could not generate suggestions.'
      emit(store)
      return
    }
    store.phase = 'ready'
    store.error = null
    emit(store)
  }

  async function trigger(sessionId, draft, actions) {
    const store = storeFor(sessionId)
    store.pendingAutomaticTrigger = undefined
    if ((store.pending && store.generationKind === 'manual') || store.awaitingDraftAck !== null) return
    if (store.pending) {
      cancelPending(store)
      store.requestSeq += 1
    }
    const triggerAt = now()
    if (store.lastAcceptedTriggerAt !== null
      && triggerAt - store.lastAcceptedTriggerAt < TRIGGER_COALESCE_MS) return
    store.lastAcceptedTriggerAt = triggerAt
    store.observedDraft = draft
    const candidate = activeCandidate(store)
    if (candidate !== undefined) {
      if (!store.candidateSkipped) {
        recordOutcome(sessionId, {
          action: 'cycled',
          origin: 'suggestion-exact',
          originalText: candidate,
        })
        rememberSkipped(store, candidate)
        store.candidateSkipped = true
      }
      const directCandidate = store.presentation === 'draft' && draft === candidate
      store.sourceDraft = directCandidate ? store.sourceDraft : draft
      clearCandidate(store, actions)
    } else {
      store.sourceDraft = draft
      if (store.phase !== 'error' || store.requestDraft !== draft) store.currentCycleSkipped = []
    }
    await requestSuggestion(sessionId, draft, actions, store, 'manual', { kind: 'manual' })
  }

  function idlePhase(phase) {
    return phase === 'plain' || phase === 'idle'
  }

  function latestTurnEnd(turnEnds) {
    if (!turnEnds || typeof turnEnds[Symbol.iterator] !== 'function') return undefined
    let latest
    for (const entry of turnEnds) {
      if (!Array.isArray(entry) || !Number.isSafeInteger(entry[0]) || !Number.isSafeInteger(entry[1])) continue
      if (latest === undefined || entry[1] > latest.endSeq) latest = { turn: entry[0], endSeq: entry[1] }
    }
    return latest
  }

  function semanticComposerIsEmpty(input) {
    return input.draft === '' && idlePhase(input.phase)
      && (!Array.isArray(input.imageIds) || input.imageIds.length === 0)
      && (!Array.isArray(input.queue) || input.queue.length === 0)
  }

  function maybeStartAutomatic(store) {
    const triggerKind = store.pendingAutomaticTrigger
    const observation = store.automaticObservation
    if (triggerKind === undefined || observation === undefined
      || !automaticPolicyReady || !config.automatic
      || observation.automaticEligible !== true
      || observation.session.running === true || observation.session.removed === true
      || !semanticComposerIsEmpty(observation.input)
      || activeCandidate(store) !== undefined || store.pending) return false
    store.pendingAutomaticTrigger = undefined
    store.sourceDraft = ''
    store.currentCycleSkipped = []
    void requestSuggestion(
      observation.sessionId,
      observation.input.draft,
      observation.actions,
      store,
      'automatic',
      triggerKind,
    )
    return true
  }

  function applyConfiguration(result) {
    if (!result || result.ok !== true) return false
    const automaticWasEnabled = config.automatic
    if (typeof result.shortcut === 'string') config.shortcut = result.shortcut
    if (typeof result.automatic === 'boolean') config.automatic = result.automatic
    if (Number.isSafeInteger(result.maxCurrentCycleSkipped)
      && result.maxCurrentCycleSkipped >= 1) {
      config.maxCurrentCycleSkipped = result.maxCurrentCycleSkipped
    }
    if (Number.isSafeInteger(result.maxCurrentCycleSkippedBytes)
      && result.maxCurrentCycleSkippedBytes >= 256) {
      config.maxCurrentCycleSkippedBytes = result.maxCurrentCycleSkippedBytes
    }
    if (Number.isSafeInteger(result.maxLocalOutcomes) && result.maxLocalOutcomes >= 0) {
      config.maxLocalOutcomes = result.maxLocalOutcomes
    }
    if (Number.isSafeInteger(result.maxLocalOutcomesBytes)
      && result.maxLocalOutcomesBytes >= 256) {
      config.maxLocalOutcomesBytes = result.maxLocalOutcomesBytes
    }
    automaticPolicyReady = true
    for (const store of stores.values()) {
      if (config.automatic) maybeStartAutomatic(store)
      else {
        let changed = false
        store.pendingAutomaticTrigger = undefined
        if (store.pending && store.generationKind === 'automatic') {
          cancelPending(store)
          store.requestSeq += 1
          store.phase = 'idle'
          store.error = null
          changed = true
        }
        if (store.presentation === 'ghost' || store.presentation === 'fallback'
          || store.presentation === 'hidden') {
          const actions = store.automaticObservation && store.automaticObservation.actions
          clearCandidate(store, actions)
          store.phase = 'idle'
          store.error = null
          changed = true
        }
        if (changed || automaticWasEnabled) emit(store)
      }
    }
    return true
  }

  function ensureConfiguration(force = false) {
    if (!force && automaticPolicyReady) return configurationRequest
    if (configurationRequest !== null) return configurationRequest
    configurationRequest = Promise.resolve()
      .then(() => rpc('configuration', {}))
      .then((result) => { applyConfiguration(result) })
      .catch(() => {})
      .finally(() => { configurationRequest = null })
    return configurationRequest
  }

  function observe(sessionId, inputValue, sessionValue, actions, automaticEligible = true) {
    const legacy = typeof inputValue === 'string'
    const input = legacy
      ? { draft: inputValue, phase: sessionValue, imageIds: [], queue: [] }
      : (inputValue || {})
    const session = legacy
      ? { running: false, removed: false, turnEnds: new Map() }
      : (sessionValue || { running: false, removed: false, turnEnds: new Map() })
    const draft = typeof input.draft === 'string' ? input.draft : ''
    const phase = typeof input.phase === 'string' ? input.phase : 'idle'
    const store = storeFor(sessionId)
    store.automaticObservation = { sessionId, input, session, actions, automaticEligible }
    if (!automaticPolicyReady) void ensureConfiguration()
    if (session.removed === true) store.pendingAutomaticTrigger = undefined
    const previousDraft = store.observedDraft
    const previousSuggestionId = store.observedSuggestionId
    const currentSuggestionId = input.suggestion && typeof input.suggestion.id === 'string'
      ? input.suggestion.id
      : undefined
    const enteringSubmission = phase === 'submitting' && store.observedPhase !== 'submitting'
    if (enteringSubmission) store.pendingAutomaticTrigger = undefined
    store.observedDraft = draft
    store.observedPhase = phase
    store.observedSuggestionId = currentSuggestionId
    let stateChanged = false
    const draftAck = store.awaitingDraftAck
    if (draftAck !== null && draft === draftAck.candidate) {
      store.awaitingDraftAck = null
      stateChanged = true
    } else if (draftAck !== null && draft !== draftAck.previousDraft) {
      store.awaitingDraftAck = null
      if (phase !== 'adjudicating' && phase !== 'submitting') store.phase = 'ready'
      stateChanged = true
    }

    let candidate = activeCandidate(store)
    if (candidate !== undefined && (store.presentation === 'ghost'
      || store.presentation === 'fallback' || store.presentation === 'hidden')) {
      const visibleBefore = previousSuggestionId === store.suggestionId
      const visibleNow = currentSuggestionId === store.suggestionId
      if (session.running === true || session.removed === true || automaticEligible !== true
        || (Array.isArray(input.queue) && input.queue.length > 0)) {
        clearCandidate(store, actions)
        store.phase = 'idle'
        store.error = null
        candidate = undefined
        stateChanged = true
      } else if (visibleBefore && !visibleNow && draft === candidate) {
        store.presentation = 'draft'
        stateChanged = true
      } else if (!semanticComposerIsEmpty(input)) {
        store.presentation = 'hidden'
        store.phase = 'idle'
        stateChanged = true
      } else if (store.presentation === 'ghost' && visibleBefore && !visibleNow) {
        clearCandidate(store, actions)
        store.phase = 'idle'
        candidate = undefined
        stateChanged = true
      } else if (store.presentation === 'hidden') {
        const suggestion = { id: store.suggestionId, text: candidate }
        store.presentation = offerSuggestion(actions, suggestion) ? 'ghost' : 'fallback'
        store.phase = 'ready'
        stateChanged = true
      }
    }

    candidate = activeCandidate(store)
    if (candidate !== undefined && store.presentation === 'draft' && enteringSubmission) {
      recordOutcome(sessionId, {
        action: 'submitted',
        origin: draft === candidate ? 'suggestion-exact' : 'suggestion-edited',
        originalText: candidate,
        finalText: draft,
      })
      cancelPending(store)
      clearCandidate(store, actions)
      store.currentCycleSkipped = []
      store.sourceDraft = ''
      store.requestDraft = ''
      store.phase = 'idle'
      stateChanged = true
    } else if (candidate === undefined && enteringSubmission) {
      if (draft.trim() !== '') {
        recordOutcome(sessionId, { action: 'submitted', origin: 'manual', finalText: draft })
      }
      const wasPending = store.pending
      cancelPending(store)
      if (wasPending) store.requestSeq += 1
      store.currentCycleSkipped = []
      store.sourceDraft = ''
      store.requestDraft = ''
      store.phase = 'idle'
      store.error = null
      if (wasPending) stateChanged = true
    } else if (store.pending && previousDraft === store.requestDraft && draft !== store.requestDraft) {
      cancelPending(store)
      store.requestSeq += 1
      store.phase = candidate === undefined ? 'idle' : 'ready'
      store.error = null
      stateChanged = true
    } else if (candidate !== undefined && store.presentation === 'draft'
      && previousDraft === candidate && draft !== candidate
      && phase !== 'adjudicating' && phase !== 'submitting') {
      store.phase = 'ready'
      stateChanged = true
    }

    const latest = latestTurnEnd(session.turnEnds)
    if (!store.observedTurnSeeded) {
      store.observedTurnSeeded = true
      store.seenTurnEndSeq = latest ? latest.endSeq : null
    } else if (latest && latest.endSeq !== store.seenTurnEndSeq && session.running !== true) {
      store.seenTurnEndSeq = latest.endSeq
      const hadCandidate = activeCandidate(store) !== undefined
      const hadPending = store.pending
      if (hadPending) {
        cancelPending(store)
        store.requestSeq += 1
      }
      if (hadCandidate) clearCandidate(store, actions)
      if (hadCandidate || hadPending) {
        store.sourceDraft = ''
        store.requestDraft = ''
        store.phase = 'idle'
        store.error = null
        stateChanged = true
      }
      store.pendingAutomaticTrigger = (!automaticPolicyReady || config.automatic)
        ? { kind: 'automatic', turn: latest.turn, endSeq: latest.endSeq }
        : undefined
    }
    if (maybeStartAutomatic(store)) return
    if (stateChanged) emit(store)
  }

  function shortcutKey(event) {
    if (event.key === ' ' || event.code === 'Space') return 'Space'
    if (typeof event.key !== 'string' || event.key === '') return undefined
    if (/^[a-z0-9]$/i.test(event.key)) return event.key.toUpperCase()
    const supported = new Set([
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
      ',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`',
    ])
    return supported.has(event.key) ? event.key : undefined
  }

  function shortcutFromEvent(event) {
    if (!event || event.isComposing || event.repeat) return undefined
    const key = shortcutKey(event)
    if (key === undefined) return undefined
    const mod = Boolean(event.metaKey) !== Boolean(event.ctrlKey)
    if (!mod && !event.altKey) return undefined
    return [
      ...(mod ? ['Mod'] : []),
      ...(!mod && event.ctrlKey ? ['Ctrl'] : []),
      ...(!mod && event.metaKey ? ['Meta'] : []),
      ...(event.altKey ? ['Alt'] : []),
      ...(event.shiftKey ? ['Shift'] : []),
      key,
    ].join('+')
  }

  function shortcutMatches(event, shortcut = config.shortcut) {
    if (shortcut === 'disabled' || event.repeat === true) return false
    const parts = shortcut.split('+')
    const key = parts.pop()
    const required = new Set(parts)
    const mod = Boolean(event.metaKey) !== Boolean(event.ctrlKey)
    return shortcutKey(event) === key
      && mod === required.has('Mod')
      && (!mod && Boolean(event.ctrlKey)) === required.has('Ctrl')
      && (!mod && Boolean(event.metaKey)) === required.has('Meta')
      && Boolean(event.altKey) === required.has('Alt')
      && Boolean(event.shiftKey) === required.has('Shift')
  }

  function isChinese() {
    try {
      return document.documentElement.lang.toLowerCase().startsWith('zh')
    } catch {
      return false
    }
  }

  function shortcutDisplay(shortcut = config.shortcut) {
    if (shortcut === 'disabled') return ''
    try {
      const platform = navigator.userAgentData && navigator.userAgentData.platform
        ? navigator.userAgentData.platform
        : navigator.platform
      if (/Mac|iPhone|iPad|iPod/i.test(platform)) {
        return shortcut
          .replace(/Mod\+/g, '⌘')
          .replace(/Ctrl\+/g, '⌃')
          .replace(/Meta\+/g, '⌘')
          .replace(/Alt\+/g, '⌥')
          .replace(/Shift\+/g, '⇧')
      }
      return shortcut.replace(/Mod\+/g, 'Ctrl+')
    } catch {
      return shortcut
    }
  }

  function tooltipText(store, zh) {
    if (store.phase === 'error') return zh ? '生成失败，点击重试' : 'Generation failed. Click to retry'
    if (store.phase === 'loading' && store.generationKind === 'automatic') {
      return zh ? '立即生成并写入' : 'Generate now and fill'
    }
    if (store.phase === 'loading') return zh ? '正在生成…' : 'Generating…'
    const action = store.presentation === 'ghost'
      ? (zh ? '换一个并写入' : 'Try another and fill')
      : activeCandidate(store) === undefined
      ? (zh ? '生成下一句' : 'Generate next message')
      : (zh ? '换一条' : 'Try another')
    const shortcut = shortcutDisplay()
    if (shortcut === '') return action
    return zh ? `${action}（${shortcut}）` : `${action} (${shortcut})`
  }

  const CSS = [
    '.dsh-pfm-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer;opacity:.82}',
    '.dsh-pfm-button:hover{background:color-mix(in srgb,currentColor 9%,transparent);opacity:1}',
    '.dsh-pfm-button:disabled{cursor:default;opacity:.4}',
    '.dsh-pfm-button[data-error="true"]{color:#d94b4b}',
    '.dsh-pfm-icon{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}',
    '.dsh-pfm-button[data-loading="true"] .dsh-pfm-icon{animation:dsh-pfm-spin 1s linear infinite}',
    '.dsh-pfm-preview{display:flex;align-items:flex-start;gap:10px;margin:0 0 8px;padding:10px 12px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;background:color-mix(in srgb,currentColor 4%,transparent)}',
    '.dsh-pfm-preview-text{flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;opacity:.72;font-size:13px;line-height:1.45}',
    '.dsh-pfm-preview-actions{display:flex;gap:6px}',
    '.dsh-pfm-preview-action{border:0;border-radius:7px;padding:5px 9px;background:color-mix(in srgb,currentColor 10%,transparent);color:inherit;cursor:pointer;font:inherit;font-size:12px}',
    '.dsh-pfm-settings-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}',
    '.dsh-pfm-settings-card:hover,.dsh-pfm-settings-card[data-open="true"]{border-color:var(--dsw-alias-label-dimmed)}',
    '.dsh-pfm-settings-card[data-open="true"]{background:var(--dsw-alias-bg-layer-2)}',
    '.dsh-pfm-settings-header{width:100%;appearance:none;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}',
    '.dsh-pfm-settings-header:focus-visible,.dsh-pfm-settings-button:focus-visible,.dsh-pfm-settings-choice:focus-within,.dsh-pfm-switch input:focus-visible+span{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    '.dsh-pfm-settings-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
    '.dsh-pfm-settings-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}',
    '.dsh-pfm-settings-description{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
    '.dsh-pfm-settings-pending{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}',
    '.dsh-pfm-settings-chevron{flex:none;color:var(--dsw-alias-label-tertiary);font-size:16px;transition:transform .16s}',
    '.dsh-pfm-settings-chevron[data-open="true"]{transform:rotate(180deg)}',
    '.dsh-pfm-settings-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
    '.dsh-pfm-settings-row{display:flex;align-items:center;gap:18px;padding:14px 0}',
    '.dsh-pfm-settings-row+.dsh-pfm-settings-row,.dsh-pfm-settings-advanced{border-top:1px solid var(--dsw-alias-border-l2)}',
    '.dsh-pfm-settings-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
    '.dsh-pfm-settings-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
    '.dsh-pfm-settings-hint,.dsh-pfm-settings-status{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
    '.dsh-pfm-settings-status[data-error="true"]{color:var(--dsw-alias-label-error)}',
    '.dsh-pfm-switch{position:relative;display:inline-flex;flex:none;width:36px;height:20px}',
    '.dsh-pfm-switch input{position:absolute;opacity:0;pointer-events:none}',
    '.dsh-pfm-switch span{width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l1);transition:background .16s;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}',
    '.dsh-pfm-switch span:after{content:"";display:block;width:16px;height:16px;margin:2px;border-radius:50%;background:var(--dsw-alias-bg-layer-3);box-shadow:0 1px 3px color-mix(in srgb,#000 24%,transparent);transition:transform .16s}',
    '.dsh-pfm-switch input:checked+span{background:var(--dsw-alias-brand-primary)}',
    '.dsh-pfm-switch input:checked+span:after{transform:translateX(16px)}',
    '.dsh-pfm-switch input:disabled+span{opacity:.45}',
    '.dsh-pfm-settings-shortcut{display:flex;align-items:center;gap:8px;flex:none}',
    '.dsh-pfm-settings-button{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;min-height:34px;padding:5px 12px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
    '.dsh-pfm-settings-button:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
    '.dsh-pfm-settings-button:disabled{opacity:.45;cursor:default}',
    '.dsh-pfm-settings-key{min-width:120px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
    '.dsh-pfm-settings-advanced-toggle{width:100%;appearance:none;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;text-align:left;padding:13px 0;cursor:pointer}',
    '.dsh-pfm-settings-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:0 0 12px}',
    '.dsh-pfm-settings-choice{position:relative;display:flex;flex-direction:column;gap:3px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;cursor:pointer;background:var(--dsw-alias-bg-layer-3)}',
    '.dsh-pfm-settings-choice[data-selected="true"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-3))}',
    '.dsh-pfm-settings-choice input{position:absolute;opacity:0;pointer-events:none}',
    '.dsh-pfm-settings-choice strong{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
    '.dsh-pfm-settings-choice small{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}',
    '.dsh-pfm-settings-select{width:100%;height:36px;margin:0 0 12px;padding:0 34px 0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
    '.dsh-pfm-settings-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
    '.dsh-pfm-settings-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}',
    '.dsh-pfm-settings-footer .dsh-pfm-settings-status{flex:1}',
    '.dsh-pfm-settings-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}',
    '@media(max-width:620px){.dsh-pfm-settings-row{align-items:flex-start;flex-direction:column;gap:9px}.dsh-pfm-settings-shortcut{width:100%}.dsh-pfm-settings-key{flex:1}.dsh-pfm-settings-choices{grid-template-columns:1fr}}',
    '@keyframes dsh-pfm-spin{to{transform:rotate(360deg)}}',
    '@media(prefers-reduced-motion:reduce){.dsh-pfm-button[data-loading="true"] .dsh-pfm-icon{animation:none}}',
  ].join('')

  function insertStyles() {
    if (document.querySelector('style[data-plugin-css="dsh-prompt-for-me"]')) return
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-prompt-for-me'
    tag.dataset.pluginCss = 'dsh-prompt-for-me'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  function SparklesIcon() {
    return React.createElement('svg', {
      className: 'dsh-pfm-icon',
      viewBox: '0 0 24 24',
      'aria-hidden': 'true',
    },
    React.createElement('path', { d: 'M12 3l1.2 3.3L16.5 7.5l-3.3 1.2L12 12l-1.2-3.3-3.3-1.2 3.3-1.2L12 3z' }),
    React.createElement('path', { d: 'M18.5 13l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z' }),
    React.createElement('path', { d: 'M5.5 14l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z' }))
  }

  function PromptForMeButton(props) {
    const sessionId = props && props.session && props.session.sessionId
    const input = props && props.input ? props.input : {}
    const actions = props && props.inputActions
    const draft = typeof input.draft === 'string' ? input.draft : ''
    const phase = typeof input.phase === 'string' ? input.phase : 'idle'
    const [, rerender] = React.useReducer((value) => value + 1, 0)
    const buttonRef = React.useRef(null)
    const store = storeFor(sessionId)
    const plan = props && typeof props.useProjection === 'function'
      ? props.useProjection('plan')
      : undefined
    const planActive = plan && typeof plan === 'object'
      ? (plan.pending ? !plan.active : plan.active)
      : false

    React.useEffect(() => {
      const listener = () => rerender()
      store.listeners.add(listener)
      return () => {
        store.listeners.delete(listener)
        if (store.listeners.size === 0) {
          cancelPending(store)
          store.requestSeq += 1
          stores.delete(sessionId)
        }
      }
    }, [sessionId, store])

    React.useEffect(() => {
      observe(sessionId, input, props.session, actions, !planActive)
    }, [sessionId, input, props.session, actions, planActive])

    React.useEffect(() => {
      const onKeyDown = (event) => {
        const active = document.activeElement
        const ownCard = buttonRef.current && buttonRef.current.closest('[data-composer-card]')
        if (!active || active.tagName !== 'TEXTAREA'
          || active.closest('[data-composer-card]') !== ownCard
          || event.isComposing || !shortcutMatches(event)
          || (props.session && (props.session.running || props.session.removed))) return
        event.preventDefault()
        void trigger(sessionId, draft, actions)
      }
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    }, [sessionId, draft, actions])

    if (sessionId === undefined || !actions || typeof actions.setDraft !== 'function') return null
    const loading = store.phase === 'loading'
    const locked = phase === 'adjudicating' || phase === 'submitting'
      || Boolean(props.session && (props.session.running || props.session.removed))
      || store.awaitingDraftAck !== null
    const zh = isChinese()
    const title = tooltipText(store, zh)
    const label = store.presentation === 'ghost'
      ? (zh ? '换一个并写入' : 'Try another and fill')
      : activeCandidate(store) === undefined
      ? (zh ? '生成下一句' : 'Generate next message')
      : (zh ? '换一条' : 'Try another')

    const triggerButton = React.createElement('button', {
      ref: buttonRef,
      type: 'button',
      className: 'dsh-pfm-button',
      title,
      'aria-label': label,
      'data-loading': String(loading),
      'data-error': String(store.phase === 'error'),
      disabled: (loading && store.generationKind !== 'automatic') || locked,
      onClick: () => { void trigger(sessionId, draft, actions) },
    }, React.createElement(SparklesIcon))
    if (store.presentation !== 'ghost' || !input.suggestion
      || input.suggestion.id !== store.suggestionId
      || typeof actions.acceptSuggestion !== 'function') return triggerButton
    const useLabel = zh ? '采用建议' : 'Use suggestion'
    return React.createElement(React.Fragment, null,
      React.createElement('button', {
        type: 'button',
        className: 'dsh-pfm-button',
        title: `${useLabel} (Tab)`,
        'aria-label': useLabel,
        onMouseDown: (event) => event.preventDefault(),
        onClick: () => actions.acceptSuggestion(store.suggestionId),
      }, React.createElement('span', { 'aria-hidden': 'true' }, '✓')),
      triggerButton)
  }

  function PromptForMePreview(props) {
    const sessionId = props && props.session && props.session.sessionId
    const actions = props && props.inputActions
    const [, rerender] = React.useReducer((value) => value + 1, 0)
    const store = storeFor(sessionId)
    React.useEffect(() => {
      const listener = () => rerender()
      store.listeners.add(listener)
      return () => {
        store.listeners.delete(listener)
        if (store.listeners.size === 0) {
          cancelPending(store)
          store.requestSeq += 1
          stores.delete(sessionId)
        }
      }
    }, [sessionId, store])
    if (sessionId === undefined || !actions || store.presentation !== 'fallback'
      || activeCandidate(store) === undefined) return null
    const zh = isChinese()
    return React.createElement('div', { className: 'dsh-pfm-preview', role: 'status' },
      React.createElement('div', { className: 'dsh-pfm-preview-text' }, activeCandidate(store)),
      React.createElement('div', { className: 'dsh-pfm-preview-actions' },
        React.createElement('button', {
          type: 'button',
          className: 'dsh-pfm-preview-action',
          onClick: () => useFallback(store, actions),
        }, zh ? '采用' : 'Use'),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-pfm-preview-action',
          'aria-label': zh ? '关闭建议' : 'Dismiss suggestion',
          onClick: () => { clearCandidate(store, actions); store.phase = 'idle'; emit(store) },
        }, '×')))
  }

  function normalizeUserSettings(value) {
    const source = value && typeof value === 'object' ? value : {}
    const route = source.route && typeof source.route === 'object'
      && typeof source.route.provider === 'string' && source.route.provider !== ''
      && typeof source.route.model === 'string' && source.route.model !== ''
      ? { provider: source.route.provider, model: source.route.model }
      : null
    return {
      automatic: typeof source.automatic === 'boolean' ? source.automatic : config.automatic,
      shortcut: typeof source.shortcut === 'string' && source.shortcut !== ''
        ? source.shortcut
        : config.shortcut,
      route,
    }
  }

  function sameUserSettings(left, right) {
    return left.automatic === right.automatic
      && left.shortcut === right.shortcut
      && ((left.route === null && right.route === null)
        || (left.route !== null && right.route !== null
          && left.route.provider === right.route.provider
          && left.route.model === right.route.model))
  }

  function routeKey(route) {
    return route === null ? '' : JSON.stringify([route.provider, route.model])
  }

  function modelOptions(groups) {
    const rows = []
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!group || typeof group.id !== 'string' || !Array.isArray(group.models)) continue
      for (const model of group.models) {
        if (!model || typeof model.id !== 'string') continue
        rows.push({
          provider: group.id,
          model: model.id,
          label: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
          providerLabel: typeof group.name === 'string' && group.name !== '' ? group.name : group.id,
        })
      }
    }
    return rows
  }

  function PromptForMeSettingsCard(props) {
    const zh = isChinese()
    const copy = zh ? {
      title: 'Prompt for Me / Prompt 嘴替',
      description: '自动准备下一条消息，也可随时手动触发。',
      expand: '展开设置', collapse: '收起设置', unsaved: '未保存',
      automatic: 'Agent 回复后自动建议',
      automaticHint: '回复完成且输入框为空时，以 Ghost Text 展示一条建议。',
      shortcut: '手动生成快捷键',
      shortcutHint: '在输入框中生成并直接填入文本；它不是接受 Ghost Text 的 Tab 键。',
      record: '按下组合键', recording: '请按组合键…', disabled: '已关闭',
      disableShortcut: '关闭', restoreShortcut: '恢复默认',
      shortcutError: '请使用 Command/Ctrl 或 Alt 加一个普通按键。',
      advanced: '高级设置', hideAdvanced: '收起高级设置', model: '建议模型',
      follow: '跟随当前 Session', followHint: '使用当前会话已经选择的模型。',
      fixed: '固定模型', fixedHint: '所有会话都使用指定模型生成建议。',
      noModels: '请先打开一个普通 Session，模型列表将在这里显示。',
      loadingModels: '正在读取当前 Session 的模型…', modelError: '模型列表读取失败，可稍后重试。',
      configured: '当前配置', readOnly: '当前设置存储为只读，不能在这里修改。',
      saveFailed: '保存没有生效，请检查 Host 设置服务。',
      discard: '放弃', save: '保存', saving: '保存中…',
    } : {
      title: 'Prompt for Me',
      description: 'Prepare the next message automatically, or trigger it whenever you need it.',
      expand: 'Expand settings', collapse: 'Collapse settings', unsaved: 'Unsaved',
      automatic: 'Suggest after the Agent replies',
      automaticHint: 'When a reply finishes and the composer is empty, offer one suggestion as ghost text.',
      shortcut: 'Manual generation shortcut',
      shortcutHint: 'Generate and fill the composer. This is separate from Tab, which accepts ghost text.',
      record: 'Press shortcut', recording: 'Press keys…', disabled: 'Disabled',
      disableShortcut: 'Disable', restoreShortcut: 'Restore default',
      shortcutError: 'Use Command/Ctrl or Alt with a regular key.',
      advanced: 'Advanced settings', hideAdvanced: 'Hide advanced settings', model: 'Suggestion model',
      follow: 'Follow current Session', followHint: 'Use the model already selected for the current session.',
      fixed: 'Fixed model', fixedHint: 'Use one specified model for suggestions in every session.',
      noModels: 'Open a regular Session first; its model directory will appear here.',
      loadingModels: 'Loading models from the current Session…', modelError: 'Could not load models. Try again later.',
      configured: 'Configured', readOnly: 'The current settings store is read-only.',
      saveFailed: 'The settings were not saved. Check the Host settings service.',
      discard: 'Discard', save: 'Save', saving: 'Saving…',
    }
    const snapshot = React.useSyncExternalStore(
      props.pfmSettingsStore.subscribe,
      props.pfmSettingsStore.getSnapshot,
    )
    const resolved = normalizeUserSettings(snapshot.value)
    const [open, setOpen] = React.useState(false)
    const [advanced, setAdvanced] = React.useState(false)
    const [draft, setDraft] = React.useState(resolved)
    const [baseline, setBaseline] = React.useState(resolved)
    const baselineRef = React.useRef(resolved)
    const [saving, setSaving] = React.useState(false)
    const [failed, setFailed] = React.useState(false)
    const [recording, setRecording] = React.useState(false)
    const [shortcutError, setShortcutError] = React.useState(false)
    const sessionId = props.useSessions((state) => state.current)
    const [models, setModels] = React.useState({
      current: null, groups: [], status: 'idle', error: null,
    })

    React.useEffect(() => {
      const previous = baselineRef.current
      baselineRef.current = resolved
      setBaseline(resolved)
      setDraft((current) => sameUserSettings(current, previous) ? resolved : current)
    }, [snapshot.revision])

    React.useEffect(() => {
      if (!advanced || sessionId === undefined || !props.pfmModelDirectories) return undefined
      let directory
      try {
        directory = props.pfmModelDirectories.directoryFor(sessionId)
      } catch {
        setModels({ current: null, groups: [], status: 'error', error: 'unavailable' })
        return undefined
      }
      const publish = () => setModels(directory.store.getSnapshot())
      publish()
      const dispose = directory.store.subscribe(publish)
      void directory.load().catch(publish)
      return dispose
    }, [advanced, sessionId, props.pfmModelDirectories])

    if (snapshot.status !== 'ready') return null
    const h = React.createElement
    const dirty = !sameUserSettings(draft, baseline)
    const writable = snapshot.writable === true
    const options = modelOptions(models.groups)
    const configuredKey = routeKey(draft.route)
    if (draft.route !== null && !options.some((option) => routeKey(option) === configuredKey)) {
      options.unshift({
        provider: draft.route.provider,
        model: draft.route.model,
        label: draft.route.model,
        providerLabel: `${draft.route.provider} · ${copy.configured}`,
      })
    }
    const currentRoute = models.current && typeof models.current.provider === 'string'
      && typeof models.current.model === 'string'
      ? { provider: models.current.provider, model: models.current.model }
      : null
    const fixedFallback = draft.route || currentRoute || options[0] || null

    const save = async () => {
      if (!dirty || !writable || saving) return
      setSaving(true)
      setFailed(false)
      await props.pfmSettingsScope.replace(draft)
      const actual = normalizeUserSettings(props.pfmSettingsScope.getSnapshot().value)
      const succeeded = sameUserSettings(actual, draft)
      baselineRef.current = actual
      setBaseline(actual)
      if (succeeded) setDraft(actual)
      setFailed(!succeeded)
      setSaving(false)
    }

    const recordShortcut = (event) => {
      if (!recording) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        setShortcutError(false)
        return
      }
      const next = shortcutFromEvent(event)
      if (next === undefined) {
        setShortcutError(true)
        return
      }
      setDraft({ ...draft, shortcut: next })
      setRecording(false)
      setShortcutError(false)
    }

    const modelStatus = sessionId === undefined
      ? copy.noModels
      : models.status === 'loading'
      ? copy.loadingModels
      : models.status === 'error'
      ? copy.modelError
      : options.length === 0
      ? copy.noModels
      : null

    return h('li', {
      className: 'dsh-pfm-settings-card',
      'data-open': String(open),
    },
    h('button', {
      type: 'button', className: 'dsh-pfm-settings-header', 'aria-expanded': open,
      'aria-label': `${open ? copy.collapse : copy.expand}: ${copy.title}`,
      onClick: () => setOpen(!open),
    },
    h('span', { className: 'dsh-pfm-settings-head-text' },
      h('span', { className: 'dsh-pfm-settings-name' }, copy.title),
      h('span', { className: 'dsh-pfm-settings-description' }, copy.description)),
    dirty ? h('span', { className: 'dsh-pfm-settings-pending' }, copy.unsaved) : null,
    h('span', {
      className: 'dsh-pfm-settings-chevron', 'data-open': String(open), 'aria-hidden': 'true',
    }, '⌄')),
    open ? h('div', { className: 'dsh-pfm-settings-body' },
      !writable ? h('p', { className: 'dsh-pfm-settings-status', role: 'status' }, copy.readOnly) : null,
      h('div', { className: 'dsh-pfm-settings-row' },
        h('span', { className: 'dsh-pfm-settings-copy' },
          h('span', { className: 'dsh-pfm-settings-label' }, copy.automatic),
          h('span', { className: 'dsh-pfm-settings-hint' }, copy.automaticHint)),
        h('label', { className: 'dsh-pfm-switch' },
          h('input', {
            type: 'checkbox', role: 'switch', checked: draft.automatic, disabled: !writable,
            'aria-label': copy.automatic,
            onChange: (event) => setDraft({ ...draft, automatic: event.target.checked }),
          }), h('span'))),
      h('div', { className: 'dsh-pfm-settings-row' },
        h('span', { className: 'dsh-pfm-settings-copy' },
          h('span', { className: 'dsh-pfm-settings-label' }, copy.shortcut),
          h('span', { className: 'dsh-pfm-settings-hint' }, copy.shortcutHint),
          shortcutError ? h('span', {
            className: 'dsh-pfm-settings-status', 'data-error': 'true', role: 'status',
          }, copy.shortcutError) : null),
        h('span', { className: 'dsh-pfm-settings-shortcut' },
          h('button', {
            type: 'button', className: 'dsh-pfm-settings-button dsh-pfm-settings-key',
            disabled: !writable, onClick: () => { setRecording(true); setShortcutError(false) },
            onKeyDown: recordShortcut,
          }, recording
            ? copy.recording
            : draft.shortcut === 'disabled' ? copy.disabled : shortcutDisplay(draft.shortcut)),
          h('button', {
            type: 'button', className: 'dsh-pfm-settings-button', disabled: !writable,
            onClick: () => {
              setRecording(false)
              setShortcutError(false)
              setDraft({ ...draft, shortcut: draft.shortcut === 'disabled'
                ? 'Mod+Shift+Space' : 'disabled' })
            },
          }, draft.shortcut === 'disabled' ? copy.restoreShortcut : copy.disableShortcut))),
      h('div', { className: 'dsh-pfm-settings-advanced' },
        h('button', {
          type: 'button', className: 'dsh-pfm-settings-advanced-toggle',
          'aria-expanded': advanced, onClick: () => setAdvanced(!advanced),
        }, advanced ? `⌃ ${copy.hideAdvanced}` : `⌄ ${copy.advanced}`),
        advanced ? h(React.Fragment, null,
          h('span', { className: 'dsh-pfm-settings-label' }, copy.model),
          h('div', { className: 'dsh-pfm-settings-choices' },
            h('label', {
              className: 'dsh-pfm-settings-choice', 'data-selected': String(draft.route === null),
            }, h('input', {
              type: 'radio', name: 'dsh-pfm-model-route', checked: draft.route === null,
              disabled: !writable, onChange: () => setDraft({ ...draft, route: null }),
            }), h('strong', null, copy.follow), h('small', null, copy.followHint)),
            h('label', {
              className: 'dsh-pfm-settings-choice',
              'data-selected': String(draft.route !== null),
            }, h('input', {
              type: 'radio', name: 'dsh-pfm-model-route', checked: draft.route !== null,
              disabled: !writable || fixedFallback === null,
              onChange: () => fixedFallback && setDraft({
                ...draft,
                route: { provider: fixedFallback.provider, model: fixedFallback.model },
              }),
            }), h('strong', null, copy.fixed), h('small', null, copy.fixedHint))),
          draft.route !== null && options.length > 0 ? h('select', {
            className: 'dsh-pfm-settings-select', value: routeKey(draft.route), disabled: !writable,
            'aria-label': copy.model,
            onChange: (event) => {
              const selected = options.find((option) => routeKey(option) === event.target.value)
              if (selected) setDraft({
                ...draft, route: { provider: selected.provider, model: selected.model },
              })
            },
          }, options.map((option) => h('option', {
            key: routeKey(option), value: routeKey(option),
          }, `${option.providerLabel} · ${option.label}`))) : null,
          modelStatus ? h('p', {
            className: 'dsh-pfm-settings-status',
            'data-error': String(models.status === 'error'), role: 'status',
          }, modelStatus) : null) : null),
      h('div', { className: 'dsh-pfm-settings-footer' },
        failed ? h('p', {
          className: 'dsh-pfm-settings-status', 'data-error': 'true', role: 'status',
        }, copy.saveFailed) : null,
        h('button', {
          type: 'button', className: 'dsh-pfm-settings-button', disabled: !dirty || saving,
          onClick: () => {
            setDraft(baseline)
            setFailed(false)
            setRecording(false)
          },
        }, copy.discard),
        h('button', {
          type: 'button', className: 'dsh-pfm-settings-button dsh-pfm-settings-save',
          disabled: !dirty || !writable || saving, onClick: () => { void save() },
        }, saving ? copy.saving : copy.save))
    ) : null)
  }

  return {
    inject: ['modelDirectories', 'slots'],
    apply(ctx) {
      insertStyles()
      const slots = ctx.get('slots')
      if (!slots) throw new Error('dsh-prompt-for-me: slots service is unavailable')
      const settingsScope = createSettingsController()
      const settingsStore = {
        getSnapshot: () => settingsScope.getSnapshot(),
        subscribe: (listener) => settingsScope.subscribe(listener),
      }
      const applySettingsSnapshot = () => {
        const snapshot = settingsScope.getSnapshot()
        if (snapshot.status !== 'ready') return
        const value = normalizeUserSettings(snapshot.value)
        applyConfiguration({ ok: true, automatic: value.automatic, shortcut: value.shortcut })
      }
      applySettingsSnapshot()
      ctx.effect(
        () => settingsScope.subscribe(applySettingsSnapshot),
        'dsh-prompt-for-me: settings updates',
      )
      void settingsScope.load()
      void ensureConfiguration(true)
      slots.inject('conversation.input.right', () => slots.register({
        name: 'conversation.input.right',
        id: 'prompt-for-me',
        order: 90,
        label: 'Prompt for Me / Prompt 嘴替',
      }, PromptForMeButton))
      slots.inject('conversation.input.dock', () => slots.register({
        name: 'conversation.input.dock',
        id: 'prompt-for-me-preview',
        order: 89,
        label: 'Prompt for Me preview / Prompt 嘴替预览',
      }, PromptForMePreview))
      slots.inject('settings.plugin.item', () => slots.register({
        name: 'settings.plugin.item',
        id: 'prompt-for-me',
        order: 30,
        label: 'Prompt for Me / Prompt 嘴替',
        inject: () => ({
          pfmSettingsScope: settingsScope,
          pfmSettingsStore: settingsStore,
          pfmModelDirectories: ctx.get('modelDirectories'),
        }),
      }, PromptForMeSettingsCard))
    },
    _testing: {
      activeCandidate,
      applyConfiguration,
      config,
      createSettingsController,
      modelOptions,
      normalizeUserSettings,
      observe,
      latestTurnEnd,
      readOutcomes,
      recordOutcome,
      shortcutMatches,
      shortcutFromEvent,
      storeFor,
      tooltipText,
      trigger,
      useFallback,
    },
  }
}
