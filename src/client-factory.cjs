'use strict'

module.exports = function createClientPlugin(React, options) {
  const RPC_PATH = '/dsh-prompt-for-me/rpc'
  const STORAGE_KEY = 'dsh.prompt-for-me.outcomes.v1'
  const TRIGGER_COALESCE_MS = 250
  const stores = new Map()
  const config = { shortcut: 'Mod+Shift+Space', maxLocalOutcomes: 50 }
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
            completion = { ok: true, batchId: event.batchId }
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
        candidates: [],
        index: -1,
        sourceDraft: '',
        observedDraft: '',
        requestSeq: 0,
        pending: false,
        awaitingNext: false,
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

  function readOutcomes() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]')
      return Array.isArray(parsed) ? parsed.slice(-config.maxLocalOutcomes) : []
    } catch {
      return []
    }
  }

  function recordOutcome(candidate, kind, resultingText) {
    if (typeof candidate !== 'string' || candidate === '') return
    const next = [...readOutcomes(), {
      candidate,
      kind,
      ...(typeof resultingText === 'string' && resultingText !== '' ? { resultingText } : {}),
      at: Date.now(),
    }].slice(-config.maxLocalOutcomes)
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Suggestion generation remains usable when local storage is unavailable.
    }
  }

  function activeCandidate(store) {
    return store.index >= 0 ? store.candidates[store.index] : undefined
  }

  function setDraft(actions, text) {
    if (actions && typeof actions.setDraft === 'function') actions.setDraft(text)
  }

  function cancelPending(store) {
    if (store.controller) store.controller.abort()
    store.controller = null
    store.pending = false
    store.awaitingNext = false
    store.awaitingDraftAck = null
  }

  function showCandidate(store, actions, index) {
    const candidate = store.candidates[index]
    if (candidate === undefined) return false
    store.index = index
    store.awaitingNext = false
    store.phase = 'ready'
    store.error = null
    store.awaitingDraftAck = {
      candidate,
      previousDraft: store.observedDraft,
    }
    setDraft(actions, candidate)
    emit(store)
    return true
  }

  async function requestBatch(sessionId, draft, excluded, actions, store, sourceDraft) {
    cancelPending(store)
    store.phase = 'loading'
    store.error = null
    store.candidates = []
    store.index = -1
    store.sourceDraft = sourceDraft
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
        draft: sourceDraft,
        excluded,
        localOutcomes: readOutcomes(),
      }, async (candidate) => {
        if (seq !== store.requestSeq || controller.signal.aborted
          || typeof candidate !== 'string' || candidate.trim() === '') return
        const normalized = candidate.trim()
        if (store.candidates.includes(normalized)) return
        store.candidates.push(normalized)
        if (store.index < 0) {
          if (store.observedDraft === draft) showCandidate(store, actions, 0)
        } else if (store.awaitingNext && store.observedDraft === activeCandidate(store)) {
          showCandidate(store, actions, store.index + 1)
        } else {
          emit(store)
        }
      }, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) return
      result = { ok: false, message: 'Prompt for Me could not reach the Harness Host.' }
    }
    if (seq !== store.requestSeq || controller.signal.aborted) return
    store.pending = false
    store.controller = null
    if (store.candidates.length === 0) {
      store.phase = 'error'
      store.error = result && typeof result.message === 'string'
        ? result.message
        : 'Prompt for Me could not generate suggestions.'
      emit(store)
      return
    }
    if (store.awaitingNext && store.observedDraft === activeCandidate(store)
      && !showCandidate(store, actions, store.index + 1)) {
      store.phase = 'error'
      store.error = 'Prompt for Me could not prepare another suggestion.'
    } else {
      store.phase = 'ready'
      store.error = null
    }
    emit(store)
  }

  async function trigger(sessionId, draft, actions) {
    const store = storeFor(sessionId)
    if (store.phase === 'loading' || store.awaitingDraftAck !== null) return
    const triggerAt = now()
    if (store.lastAcceptedTriggerAt !== null
      && triggerAt - store.lastAcceptedTriggerAt < TRIGGER_COALESCE_MS) return
    store.lastAcceptedTriggerAt = triggerAt
    store.observedDraft = draft
    const candidate = activeCandidate(store)
    if (candidate !== undefined && draft === candidate) {
      recordOutcome(candidate, 'cycled')
      if (store.index + 1 < store.candidates.length) {
        showCandidate(store, actions, store.index + 1)
        return
      }
      if (store.pending) {
        store.awaitingNext = true
        store.phase = 'loading'
        store.error = null
        emit(store)
        return
      }
      await requestBatch(
        sessionId,
        draft,
        [...store.candidates],
        actions,
        store,
        store.sourceDraft,
      )
      return
    }
    if (candidate !== undefined && draft !== candidate) {
      recordOutcome(candidate, 'edited', draft)
    }
    await requestBatch(sessionId, draft, [], actions, store, draft)
  }

  function observe(sessionId, draft, phase) {
    const store = storeFor(sessionId)
    const previousDraft = store.observedDraft
    store.observedDraft = draft
    let stateChanged = false
    const draftAck = store.awaitingDraftAck
    if (draftAck !== null && draft === draftAck.candidate) {
      store.awaitingDraftAck = null
      stateChanged = true
    } else if (draftAck !== null && draft !== draftAck.previousDraft) {
      store.awaitingDraftAck = null
      store.awaitingNext = false
      if (phase !== 'adjudicating' && phase !== 'submitting') store.phase = 'ready'
      stateChanged = true
    }
    const candidate = activeCandidate(store)
    if (candidate !== undefined && phase === 'submitting') {
      recordOutcome(candidate, draft === candidate ? 'submitted-exact' : 'submitted-edited', draft)
      cancelPending(store)
      store.candidates = []
      store.index = -1
      store.phase = 'idle'
      emit(store)
    } else if (store.pending && candidate === undefined
      && previousDraft === store.sourceDraft && draft !== store.sourceDraft) {
      cancelPending(store)
      store.requestSeq += 1
      store.phase = 'idle'
      store.error = null
      emit(store)
    } else if (candidate !== undefined && previousDraft === candidate && draft !== candidate
      && phase !== 'adjudicating' && phase !== 'submitting') {
      store.awaitingNext = false
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
          if (Number.isSafeInteger(result.maxLocalOutcomes) && result.maxLocalOutcomes >= 0) {
            config.maxLocalOutcomes = result.maxLocalOutcomes
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
