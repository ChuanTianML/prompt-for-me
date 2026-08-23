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
    const previousDraft = store.observedDraft
    const previousSuggestionId = store.observedSuggestionId
    const currentSuggestionId = input.suggestion && typeof input.suggestion.id === 'string'
      ? input.suggestion.id
      : undefined
    const enteringSubmission = phase === 'submitting' && store.observedPhase !== 'submitting'
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
      if (config.automatic && automaticEligible === true && session.removed !== true
        && semanticComposerIsEmpty(input) && activeCandidate(store) === undefined && !store.pending) {
        store.sourceDraft = ''
        store.currentCycleSkipped = []
        void requestSuggestion(
          sessionId,
          draft,
          actions,
          store,
          'automatic',
          { kind: 'automatic', turn: latest.turn, endSeq: latest.endSeq },
        )
        return
      }
    }
    if (stateChanged) emit(store)
  }

  function shortcutMatches(event) {
    if (config.shortcut === 'disabled' || event.repeat === true) return false
    return (event.key === ' ' || event.code === 'Space')
      && event.shiftKey === true
      && event.altKey !== true
      && ((event.metaKey === true && event.ctrlKey !== true)
        || (event.ctrlKey === true && event.metaKey !== true))
  }

  function isChinese() {
    try {
      return document.documentElement.lang.toLowerCase().startsWith('zh')
    } catch {
      return false
    }
  }

  function shortcutDisplay() {
    if (config.shortcut === 'disabled') return ''
    if (config.shortcut !== 'Mod+Shift+Space') return config.shortcut
    try {
      const platform = navigator.userAgentData && navigator.userAgentData.platform
        ? navigator.userAgentData.platform
        : navigator.platform
      return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘⇧Space' : 'Ctrl+Shift+Space'
    } catch {
      return 'Mod+Shift+Space'
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

  return {
    inject: ['slots'],
    apply(ctx) {
      insertStyles()
      const slots = ctx.get('slots')
      if (!slots) throw new Error('dsh-prompt-for-me: slots service is unavailable')
      void rpc('configuration', {}).then((result) => {
        if (result && result.ok === true) {
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
        }
      }).catch(() => {})
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
    },
    _testing: {
      activeCandidate,
      config,
      observe,
      latestTurnEnd,
      readOutcomes,
      recordOutcome,
      shortcutMatches,
      storeFor,
      tooltipText,
      trigger,
      useFallback,
    },
  }
}
