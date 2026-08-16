'use strict'

module.exports = function createClientPlugin(React, options) {
  const RPC_PATH = '/dsh-prompt-for-me/rpc'
  const STORAGE_KEY = 'dsh.prompt-for-me.outcomes.v1'
  const stores = new Map()
  const config = { shortcut: 'Mod+Shift+Space', maxLocalOutcomes: 50 }
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

  async function requestBatch(sessionId, draft, excluded, actions, store, sourceDraft) {
    store.phase = 'loading'
    store.error = null
    store.requestSeq += 1
    const seq = store.requestSeq
    const expectedDraft = draft
    emit(store)
    let result
    try {
      result = await rpc('generate', {
        sessionId,
        draft: sourceDraft,
        excluded,
        localOutcomes: readOutcomes(),
      })
    } catch {
      result = { ok: false, message: 'Prompt for Me could not reach the Harness Host.' }
    }
    if (seq !== store.requestSeq) return
    if (store.observedDraft !== expectedDraft) {
      store.phase = 'idle'
      emit(store)
      return
    }
    if (!result || result.ok !== true || !Array.isArray(result.candidates)
      || result.candidates.length === 0) {
      store.phase = 'error'
      store.error = result && typeof result.message === 'string'
        ? result.message
        : 'Prompt for Me could not generate suggestions.'
      emit(store)
      return
    }
    store.phase = 'ready'
    store.error = null
    store.candidates = result.candidates.filter((value) => typeof value === 'string' && value.trim() !== '')
    store.index = 0
    store.sourceDraft = sourceDraft
    const first = activeCandidate(store)
    if (first === undefined) {
      store.phase = 'error'
      store.error = 'Prompt for Me returned an empty suggestion batch.'
    } else {
      store.observedDraft = first
      setDraft(actions, first)
    }
    emit(store)
  }

  async function trigger(sessionId, draft, actions) {
    const store = storeFor(sessionId)
    store.observedDraft = draft
    if (store.phase === 'loading') return
    const candidate = activeCandidate(store)
    if (candidate !== undefined && draft === candidate) {
      recordOutcome(candidate, 'cycled')
      if (store.index + 1 < store.candidates.length) {
        store.index += 1
        const next = activeCandidate(store)
        store.observedDraft = next
        setDraft(actions, next)
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
    if (candidate !== undefined && draft !== candidate) recordOutcome(candidate, 'edited', draft)
    store.candidates = []
    store.index = -1
    await requestBatch(sessionId, draft, [], actions, store, draft)
  }

  function observe(sessionId, draft, phase) {
    const store = storeFor(sessionId)
    const previousDraft = store.observedDraft
    store.observedDraft = draft
    const candidate = activeCandidate(store)
    if (candidate !== undefined && phase === 'submitting') {
      recordOutcome(candidate, draft === candidate ? 'submitted-exact' : 'submitted-edited', draft)
      store.candidates = []
      store.index = -1
      store.phase = 'idle'
      emit(store)
    } else if (candidate !== undefined && previousDraft === candidate && draft !== candidate
      && phase !== 'adjudicating' && phase !== 'submitting' && draft !== '') {
      store.phase = 'ready'
    }
  }

  function shortcutMatches(event) {
    if (config.shortcut === 'disabled') return false
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
        if (store.listeners.size === 0 && store.phase !== 'loading') stores.delete(sessionId)
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
    const zh = isChinese()
    const title = store.error
      || (activeCandidate(store) === undefined
        ? (zh ? `帮我说（${config.shortcut}）` : `Prompt for Me (${config.shortcut})`)
        : (zh ? `换一条（${config.shortcut}）` : `Try another (${config.shortcut})`))

    return React.createElement('button', {
      type: 'button',
      className: 'dsh-pfm-button',
      title,
      'aria-label': 'Prompt for Me',
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
      trigger,
    },
  }
}
