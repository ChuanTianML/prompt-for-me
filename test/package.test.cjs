'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')

test('package declares an installable DSH bundle and web client', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.keywords.includes('dsh-plugin'), true)
  assert.equal(manifest.dependencies['@deepseek-ai/schemastery'], '^3.18.1')
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-model-selection',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
  ])
  for (const name of manifest.dsh.client.inject) {
    assert.equal(manifest.peerDependenciesMeta[name].optional, true)
  }
})

test('generated host and client artifacts are loadable and self-contained', () => {
  const host = require('../lib/index.cjs')
  assert.equal(host.name, 'dsh-prompt-for-me')
  assert.equal(typeof host.apply, 'function')
  const client = readFileSync(join(root, 'lib', 'client.cjs'), 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load/)
  assert.match(client, /id: "dsh-prompt-for-me"/)
  assert.doesNotMatch(client, /require\("\.\//)
})
