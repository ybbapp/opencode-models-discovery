import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { persistConfigModels } from '../../src/v2/config-models.js'
import type { DiscoveredV2Model } from '../../src/v2/catalog.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => fs.rm(path, { recursive: true, force: true }))) })
const options = { enabled: true, persistModels: { enabled: true } }
const provider = { id: 'local', package: 'compatible', settings: { baseURL: 'http://example.test/v1', apiKey: 'test-secret', modelsDiscovery: options } }
function models(id = 'stable', name = 'Stable'): Map<string, DiscoveredV2Model> {
  return new Map([[id, { id, modelID: id, name, capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 32000, output: 8000 } }]])
}
async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'config-models-test-')); directories.push(directory)
  const file = join(directory, 'opencode.jsonc')
  await fs.writeFile(file, '// retain this comment\n'+JSON.stringify({ providers: { local: { ...provider, id: undefined, models: { manual: { name: 'Manual' } } } } }, null, 2))
  return { directory, file, read: async () => parse(await fs.readFile(file, 'utf8')) }
}

describe('persist successful models to JSONC', () => {
  it('adds generated models, preserves manual entries/comments and makes unchanged refresh a no-op', async () => {
    const f = await fixture()
    expect(await persistConfigModels(f.file, provider, models())).toBe(true)
    const original = await fs.readFile(f.file, 'utf8'); const stat = await fs.stat(f.file)
    expect(original).toContain('// retain this comment')
    expect((await f.read()).providers.local.models.manual).toEqual({ name: 'Manual' })
    expect((await f.read()).providers.local.models.stable.modelID).toBe('stable')
    expect(await persistConfigModels(f.file, provider, models())).toBe(false)
    expect(await fs.readFile(f.file, 'utf8')).toBe(original)
    expect((await fs.stat(f.file)).mtimeMs).toBe(stat.mtimeMs)
    expect((await fs.readdir(f.directory))).toEqual(['opencode.jsonc'])
  })
  it('updates/removes only unchanged managed entries and accepts a successful empty inventory', async () => {
    const f = await fixture()
    await persistConfigModels(f.file, provider, models())
    await persistConfigModels(f.file, provider, models('stable', 'Updated'))
    expect((await f.read()).providers.local.models.stable.name).toBe('Updated')
    await persistConfigModels(f.file, provider, new Map())
    expect((await f.read()).providers.local.models).toEqual({ manual: { name: 'Manual' } })
  })
  it('preserves user edits to generated entries and releases ownership', async () => {
    const f = await fixture(); await persistConfigModels(f.file, provider, models())
    const doc = await f.read(); doc.providers.local.models.stable.limit.output = 12345
    await fs.writeFile(f.file, JSON.stringify(doc, null, 2))
    await persistConfigModels(f.file, provider, models('stable', 'New name'))
    let saved = await f.read()
    expect(saved.providers.local.models.stable.limit.output).toBe(12345)
    expect(saved.providers.local.models.stable.name).toBe('Stable')
    expect(saved.providers.local.settings.modelsDiscovery.persistModels.managedModels).toEqual({})
    await persistConfigModels(f.file, provider, new Map())
    saved = await f.read(); expect(saved.providers.local.models.stable).toBeDefined()
  })
  it('does not overwrite malformed or changed provider configuration', async () => {
    const f = await fixture()
    const doc = await f.read(); doc.providers.local.settings.apiKey = 'other-account'
    const changed = JSON.stringify(doc); await fs.writeFile(f.file, changed)
    await expect(persistConfigModels(f.file, provider, models())).rejects.toThrow('credentials changed')
    expect(await fs.readFile(f.file, 'utf8')).toBe(changed)
    await fs.writeFile(f.file, '{ broken')
    await expect(persistConfigModels(f.file, provider, models())).rejects.toThrow('invalid JSONC')
    expect(await fs.readFile(f.file, 'utf8')).toBe('{ broken')
  })
  it('keeps the original file on lock contention and preserves its permissions on success', async () => {
    const f = await fixture(); const before = await fs.readFile(f.file, 'utf8')
    await fs.writeFile(f.file+'.models-discovery.lock', '')
    await expect(persistConfigModels(f.file, provider, models())).rejects.toThrow()
    expect(await fs.readFile(f.file, 'utf8')).toBe(before)
    await fs.unlink(f.file+'.models-discovery.lock'); await fs.chmod(f.file, 0o600)
    await persistConfigModels(f.file, provider, models())
    expect((await fs.stat(f.file)).mode & 0o777).toBe(0o600)
  })
  it('serializes concurrent writes without dropping a provider', async () => {
    const f = await fixture(); const doc = await f.read()
    const other = { ...provider, id: 'other' }; doc.providers.other = { package: other.package, settings: other.settings }
    await fs.writeFile(f.file, JSON.stringify(doc))
    await Promise.all([persistConfigModels(f.file, provider, models()), persistConfigModels(f.file, other, models('second'))])
    const saved = await f.read()
    expect(saved.providers.local.models.stable).toBeDefined(); expect(saved.providers.other.models.second).toBeDefined()
  })
})
