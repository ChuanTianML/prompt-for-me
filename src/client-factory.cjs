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
        currentCycleSkipped: [],
        sourceDraft: '',
        requestDraft: '',
        observedDraft: '',
        observedPhase: null,
        requestSeq: 0,
        pending: false,
        awaitingDraftAck: null,
        lastAcceptedTriggerAt: null,
        controller: null,
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

  function cancelPending(store) {
    if (store.controller) store.controller.abort()
    store.controller = null
    store.pending = false
    store.awaitingDraftAck = null
  }

  function showCandidate(store, actions, candidate) {
    store.candidate = candidate
    store.candidateSkipped = false
    store.phase = store.pending ? 'loading' : 'ready'
    store.error = null
    store.awaitingDraftAck = {
      candidate,
      previousDraft: store.observedDraft,
    }
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

  async function requestSuggestion(sessionId, draft, actions, store) {
    cancelPending(store)
    store.phase = 'loading'
    store.error = null
    store.requestDraft = draft
    store.pending = true
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
        currentCycleSkipped: [...store.currentCycleSkipped],
        localOutcomes: readOutcomes(),
      }, async (candidate) => {
        if (seq !== store.requestSeq || controller.signal.aborted
          || typeof candidate !== 'string' || candidate.trim() === '') return
        if (store.observedDraft === draft) showCandidate(store, actions, candidate.trim())
      }, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) return
      result = { ok: false, message: 'Prompt for Me could not reach the Harness Host.' }
    }
    if (seq !== store.requestSeq || controller.signal.aborted) return
    store.pending = false
    store.controller = null
    if (!result || result.ok !== true || activeCandidate(store) === undefined
      || store.candidateSkipped) {
      store.phase = 'error'
      store.error = result && typeof result.message === 'string'
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
    if (store.pending || store.awaitingDraftAck !== null) return
    const triggerAt = now()
    if (store.lastAcceptedTriggerAt !== null
      && triggerAt - store.lastAcceptedTriggerAt < TRIGGER_COALESCE_MS) return
    store.lastAcceptedTriggerAt = triggerAt
    store.observedDraft = draft
    const candidate = activeCandidate(store)
    if (candidate !== undefined && draft === candidate) {
      if (!store.candidateSkipped) {
        recordOutcome(sessionId, {
          action: 'cycled',
          origin: 'suggestion-exact',
          originalText: candidate,
        })
        rememberSkipped(store, candidate)
        store.candidateSkipped = true
      }
      await requestSuggestion(sessionId, draft, actions, store)
      return
    }
    if (candidate !== undefined && draft !== candidate) {
      if (!store.candidateSkipped) {
        recordOutcome(sessionId, {
          action: 'cycled',
          origin: 'suggestion-exact',
          originalText: candidate,
        })
        rememberSkipped(store, candidate)
        store.candidateSkipped = true
      }
      store.sourceDraft = draft
    } else {
      store.sourceDraft = draft
      store.currentCycleSkipped = []
    }
    await requestSuggestion(sessionId, draft, actions, store)
  }

  function observe(sessionId, draft, phase) {
    const store = storeFor(sessionId)
    const previousDraft = store.observedDraft
    const enteringSubmission = phase === 'submitting' && store.observedPhase !== 'submitting'
    store.observedDraft = draft
    store.observedPhase = phase
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
    const candidate = activeCandidate(store)
    if (candidate !== undefined && enteringSubmission) {
      recordOutcome(sessionId, {
        action: 'submitted',
        origin: draft === candidate ? 'suggestion-exact' : 'suggestion-edited',
        originalText: candidate,
        finalText: draft,
      })
      cancelPending(store)
      store.candidate = undefined
      store.candidateSkipped = false
      store.currentCycleSkipped = []
      store.sourceDraft = ''
      store.requestDraft = ''
      store.phase = 'idle'
      emit(store)
    } else if (candidate === undefined && enteringSubmission) {
      if (typeof draft === 'string' && draft.trim() !== '') {
        recordOutcome(sessionId, {
          action: 'submitted',
          origin: 'manual',
          finalText: draft,
        })
      }
      const wasPending = store.pending
      cancelPending(store)
      if (wasPending) store.requestSeq += 1
      store.candidateSkipped = false
      store.currentCycleSkipped = []
      store.sourceDraft = ''
      store.requestDraft = ''
      store.phase = 'idle'
      store.error = null
      if (wasPending) emit(store)
    } else if (store.pending && previousDraft === store.requestDraft && draft !== store.requestDraft) {
      cancelPending(store)
      store.requestSeq += 1
      store.phase = candidate === undefined ? 'idle' : 'ready'
      store.error = null
      emit(store)
    } else if (candidate !== undefined && previousDraft === candidate && draft !== candidate
      && phase !== 'adjudicating' && phase !== 'submitting') {
      store.phase = 'ready'
      emit(store)
    } else if (stateChanged) {
      emit(store)
    }
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
    if (store.phase === 'loading') return zh ? '正在生成…' : 'Generating…'
    const action = activeCandidate(store) === undefined
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

    React.useEffect(() => {
      observe(sessionId, draft, phase)
    }, [sessionId, draft, phase])

    React.useEffect(() => {
      const onKeyDown = (event) => {
        if (!shortcutMatches(event)) return
        event.preventDefault()
        void trigger(sessionId, draft, actions)
      }
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    }, [sessionId, draft, actions])

    if (sessionId === undefined || !actions || typeof actions.setDraft !== 'function') return null
    const loading = store.phase === 'loading'
    const locked = phase === 'adjudicating' || phase === 'submitting'
      || store.awaitingDraftAck !== null
    const zh = isChinese()
    const title = tooltipText(store, zh)
    const label = activeCandidate(store) === undefined
      ? (zh ? '生成下一句' : 'Generate next message')
      : (zh ? '换一条' : 'Try another')

    return React.createElement('button', {
      type: 'button',
      className: 'dsh-pfm-button',
      title,
      'aria-label': label,
      'data-loading': String(loading),
      'data-error': String(store.phase === 'error'),
      disabled: loading || locked,
      onClick: () => { void trigger(sessionId, draft, actions) },
    }, React.createElement(SparklesIcon))
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
    },
    _testing: {
      activeCandidate,
      config,
      observe,
      readOutcomes,
      recordOutcome,
      shortcutMatches,
      storeFor,
      tooltipText,
      trigger,
    },
  }
}
