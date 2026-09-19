'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { runInThisContext } = require('node:vm')
const { JSDOM } = require('jsdom')
const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React
const createPlugin = require('../src/client-factory.cjs')

async function settingsCard() {
  const dom = new JSDOM('<!doctype html><html lang="en"><head></head><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
  })
  global.window = dom.window
  global.document = dom.window.document
  global.IS_REACT_ACT_ENVIRONMENT = true
  window.fetch = async () => ({ json: async () => ({ ok: false }) })
  let plugin
  if (process.env.PFM_UI_BUNDLE_PATH) {
    window.__ModuleLoader__ = { load: (entry) => { plugin = entry.factory(require) } }
    runInThisContext(readFileSync(process.env.PFM_UI_BUNDLE_PATH, 'utf8'))
  } else {
    plugin = createPlugin(React, { automatic: false, rpc: async () => ({ ok: false }) })
  }
  const entries = new Map()
  const slots = {
    inject: (_name, fn) => fn(),
    register: (entry, component) => { entries.set(entry.name, component); return () => {} },
  }
  plugin.apply({ get: (name) => name === 'slots' ? slots : undefined, effect: (fn) => fn() })
  const root = createRoot(document.getElementById('root'))
  let snapshot = { status: 'ready', revision: 1, writable: true,
    value: { automatic: true, shortcut: 'Mod+Shift+Space', route: null } }
  const listeners = new Set()
  const saves = []
  const store = { getSnapshot: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) } }
  const scope = { getSnapshot: store.getSnapshot,
    replace: (value) => new Promise((resolve, reject) => {
      saves.push({ value, resolve, reject, publish() {
        snapshot = { ...snapshot, value, revision: snapshot.revision + 1 }
        for (const listener of listeners) listener()
      } })
    }) }
  const props = { pfmSettingsStore: store, pfmSettingsScope: scope,
    useSessions: (select) => select({ current: undefined }) }
  const click = async (selector) => act(async () => {
    document.querySelector(selector).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => root.render(React.createElement(entries.get('settings.plugin.item'), props)))
  await click('.dsh-pfm-settings-header')
  return { saves, click, checked: () => document.querySelector('input[type="checkbox"]').checked,
    saveDisabled: () => document.querySelector('.dsh-pfm-settings-save').disabled,
    async close() {
      await act(async () => root.unmount())
      dom.window.close()
      delete global.window
      delete global.document
      delete global.IS_REACT_ACT_ENVIRONMENT
    } }
}

for (const notification of ['before completion', 'with completion']) {
  test(`new settings edits survive a saved snapshot ${notification} and can be saved separately`, async () => {
    const card = await settingsCard()
    try {
      await card.click('input[type="checkbox"]')
      await card.click('.dsh-pfm-settings-save')
      assert.equal(card.saves[0].value.automatic, false)
      await card.click('input[type="checkbox"]')
      assert.equal(card.checked(), true)
      if (notification === 'before completion') {
        await act(async () => card.saves[0].publish())
        assert.equal(card.checked(), true)
        await act(async () => card.saves[0].resolve())
      } else {
        await act(async () => { card.saves[0].publish(); card.saves[0].resolve() })
      }
      assert.equal(card.checked(), true)
      assert.equal(card.saveDisabled(), false)
      assert.equal(document.querySelector('.dsh-pfm-settings-pending').textContent, 'Unsaved')
      await card.click('.dsh-pfm-settings-save')
      assert.equal(card.saves[1].value.automatic, true)
      await act(async () => { card.saves[1].publish(); card.saves[1].resolve() })
      assert.equal(card.checked(), true)
      assert.equal(card.saveDisabled(), true)
      assert.equal(document.querySelector('.dsh-pfm-settings-pending'), null)
    } finally { await card.close() }
  })
}

test('saving without newer edits clears the unsaved indicator', async () => {
  const card = await settingsCard()
  try {
    await card.click('input[type="checkbox"]')
    await card.click('.dsh-pfm-settings-save')
    await act(async () => card.saves[0].publish())
    await act(async () => card.saves[0].resolve())
    assert.equal(card.checked(), false)
    assert.equal(card.saveDisabled(), true)
    assert.equal(document.querySelector('.dsh-pfm-settings-pending'), null)
  } finally { await card.close() }
})

for (const failure of ['unchanged snapshot', 'rejected promise']) {
  test(`a save with ${failure} preserves edits and allows retry`, async () => {
    const card = await settingsCard()
    try {
      await card.click('input[type="checkbox"]')
      await card.click('.dsh-pfm-settings-save')
      await act(async () => {
        if (failure === 'rejected promise') card.saves[0].reject(new Error('storage unavailable'))
        else card.saves[0].resolve()
      })
      assert.equal(card.checked(), false)
      assert.equal(card.saveDisabled(), false)
      assert.ok(document.querySelector('.dsh-pfm-settings-status[data-error="true"]'))
      await card.click('.dsh-pfm-settings-save')
      await act(async () => { card.saves[1].publish(); card.saves[1].resolve() })
      assert.equal(card.saveDisabled(), true)
      assert.equal(document.querySelector('.dsh-pfm-settings-status[data-error="true"]'), null)
    } finally { await card.close() }
  })
}
