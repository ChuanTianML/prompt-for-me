import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)

for (const pluginFirst of [false, true]) {
  test(`installed Host loads alongside an ESM schema consumer (plugin first: ${pluginFirst})`, (t) => {
    const fixture = mkdtempSync(join(tmpdir(), 'prompt-for-me-loading-'))
    t.after(() => rmSync(fixture, { recursive: true, force: true }))
    const modules = join(fixture, 'node_modules')
    const plugin = join(modules, 'dsh-prompt-for-me')
    mkdirSync(plugin, { recursive: true })
    cpSync(join(root, 'lib'), join(plugin, 'lib'), { recursive: true })
    cpSync(join(root, 'package.json'), join(plugin, 'package.json'))

    const schemaManifest = require.resolve('@deepseek-ai/schemastery/package.json')
    const schemaRequire = createRequire(schemaManifest)
    for (const manifest of [schemaManifest, schemaRequire.resolve('@deepseek-ai/cosmokit/package.json')]) {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'))
      cpSync(dirname(manifest), join(modules, name), { recursive: true })
    }

    writeFileSync(join(fixture, 'schema-consumer.mjs'), `
import z from '@deepseek-ai/schemastery'
export const schema = z.object({ enabled: z.boolean().default(true) })
`)
    const imports = ["import('./schema-consumer.mjs')", "import('dsh-prompt-for-me')"]
    if (pluginFirst) imports.reverse()
    writeFileSync(join(fixture, 'load.mjs'), `
import assert from 'node:assert/strict'
const loaded = await Promise.all([${imports.join(', ')}])
const host = loaded[${pluginFirst ? 0 : 1}].default
assert.equal(host.name, 'dsh-prompt-for-me')
assert.equal(typeof host.apply, 'function')
assert.equal(typeof host._testing.UserSettingsSchema, 'function')
console.log('Host and ESM schema consumer loaded')
`)

    // Each process starts with an empty module cache, including the shared ESM dependency.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = spawnSync(process.execPath, [join(fixture, 'load.mjs')], {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, NODE_OPTIONS: '' },
      })
      assert.ifError(result.error)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Host and ESM schema consumer loaded/)
    }
  })
}
