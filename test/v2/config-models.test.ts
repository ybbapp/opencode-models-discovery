import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'jsonc-parser'
import { persistedConfigPath, persistConfigModels } from '../../src/v2/config-models.js'
import type { DiscoveredV2Model } from '../../src/v2/catalog.js'

const directories: string[] = []
afterEach(() => vi.unstubAllEnvs())
afterEach(async () => { await Promise.all(directories.splice(0).map(path => fs.rm(path, { recursive: true, force: true }))) })
const options = { enabled: true, persistModels: { enabled: true } }
const provider = { id: 'local', package: 'compatible', settings: { baseURL: 'http://example.test/v1', apiKey: 'test-secret', modelsDiscovery: options } }
function models(id = 'stable', name = 'Stable'): Map<string, DiscoveredV2Model> {
  return new Map([[id, { id, modelID: id, name, capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 32000, output: 8000 } }]])
}
function modelsWithVariants(): Map<string, DiscoveredV2Model> {
  return new Map([['stable', {
    id: 'stable',
    modelID: 'stable',
    name: 'Stable',
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    limit: { context: 32000, output: 8000 },
    reasoning: true,
    variants: [
      { id: 'low', settings: { reasoningEffort: 'low' } },
      { id: 'high', settings: { reasoningEffort: 'high' } },
    ],
  }]])
}
async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'config-models-test-')); directories.push(directory)
  const file = join(directory, 'opencode.jsonc')
  await fs.writeFile(file, '// retain this comment\n'+JSON.stringify({ providers: { local: { ...provider, id: undefined, models: { manual: { name: 'Manual' } } } } }, null, 2))
  return { directory, file, read: async () => parse(await fs.readFile(file, 'utf8')) }
}

describe('configuration path resolution', () => {
  it('expands home-relative paths and keeps project-relative and absolute paths', () => {
    expect(persistedConfigPath({ enabled: true, path: '~/.config/opencode/opencode.jsonc' }, '/project')).toBe(join(homedir(), '.config/opencode/opencode.jsonc'))
    expect(persistedConfigPath({ enabled: true, path: './opencode.jsonc' }, '/project')).toBe('/project/opencode.jsonc')
    expect(persistedConfigPath({ enabled: true, path: '../opencode.jsonc' }, '/project/nested')).toBe('/project/opencode.jsonc')
    expect(persistedConfigPath({ enabled: true, path: '/global/opencode.jsonc' }, '/project')).toBe('/global/opencode.jsonc')
    expect(persistedConfigPath({ enabled: true, path: './opencode.jsonc' })).toBe(resolve('opencode.jsonc'))
  })
  it('expands home paths in environment fallbacks and preserves explicit-path precedence', () => {
    vi.stubEnv('OPENCODE_CONFIG', '~/custom/opencode.jsonc')
    expect(persistedConfigPath({ enabled: true })).toBe(join(homedir(), 'custom/opencode.jsonc'))
    expect(persistedConfigPath({ enabled: true, path: './local.jsonc' }, '/project')).toBe('/project/local.jsonc')
    vi.stubEnv('OPENCODE_CONFIG', '')
    vi.stubEnv('OPENCODE_CONFIG_DIR', '~/custom-config')
    expect(persistedConfigPath({ enabled: true })).toBe(join(homedir(), 'custom-config/opencode.jsonc'))
  })
})

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
  it('persists reasoning variants so the effort picker survives reload', async () => {
    const f = await fixture()
    expect(await persistConfigModels(f.file, provider, modelsWithVariants())).toBe(true)
    const saved = await f.read()
    expect(saved.providers.local.models.stable.variants).toEqual([
      { id: 'low', settings: { reasoningEffort: 'low' } },
      { id: 'high', settings: { reasoningEffort: 'high' } },
    ])
    expect(saved.providers.local.models.stable.capabilities.reasoning).toEqual({ supported: true })
    expect(await persistConfigModels(f.file, provider, modelsWithVariants())).toBe(false)
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
