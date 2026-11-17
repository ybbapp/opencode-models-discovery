import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inventorySnapshotKey, inventorySnapshotTestUtils, readInventorySnapshot, writeInventorySnapshot } from '../../src/v2/inventory-snapshot.js'
import type { DiscoveredV2Model } from '../../src/v2/catalog.js'

const provider = { id: 'snapshot-local', package: 'compatible', settings: { baseURL: 'https://example.test/v1' }, apiKey: 'account-a' }
const models = new Map<string, DiscoveredV2Model>([['stable', {
  id: 'stable', modelID: 'stable', name: 'Stable',
  capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 32000, output: 8000 },
}]])
function storage() {
  const values = new Map<string, unknown>()
  return { values, get: vi.fn(async (key: string) => values.get(key)), set: vi.fn(async (key: string, value: unknown) => { values.set(key, value) }) }
}

describe('last successful inventory', () => {
  beforeEach(() => inventorySnapshotTestUtils.reset())
  it('restores across a module-memory reset and returns independent model objects', async () => {
    const s = storage(); const key = inventorySnapshotKey(provider, '/project')
    await writeInventorySnapshot(s as never, key, models)
    inventorySnapshotTestUtils.reset()
    const restored = await readInventorySnapshot(s as never, key)
    expect(restored).toEqual(models)
    restored!.get('stable')!.limit.context = 1
    expect((await readInventorySnapshot(s as never, key))!.get('stable')!.limit.context).toBe(32000)
  })
  it('does not reuse inventory for a different credential, endpoint, filter, or project', async () => {
    const s = storage(); await writeInventorySnapshot(s as never, inventorySnapshotKey(provider, '/project'), models)
    for (const [p, directory] of [
      [{ ...provider, apiKey: 'account-b' }, '/project'],
      [{ ...provider, settings: { baseURL: 'https://other.test/v1' } }, '/project'],
      [{ ...provider, settings: { ...provider.settings, modelsDiscovery: { models: { excludeRegex: ['stable'] } } } }, '/project'],
      [provider, '/other'],
    ] as const) expect(await readInventorySnapshot(s as never, inventorySnapshotKey(p, directory))).toBeUndefined()
    expect(JSON.stringify([...s.values])).not.toContain('account-a')
  })
  it('keeps the previous disk snapshot if a write fails, but retains the successful response in memory', async () => {
    const s = storage(); const key = inventorySnapshotKey(provider)
    await writeInventorySnapshot(s as never, key, models)
    s.set.mockRejectedValueOnce(new Error('disk unavailable'))
    await writeInventorySnapshot(s as never, key, new Map())
    expect(await readInventorySnapshot(s as never, key)).toEqual(new Map())
    inventorySnapshotTestUtils.reset()
    expect(await readInventorySnapshot(s as never, key)).toEqual(models)
  })
  it('accepts a successful empty replacement and rejects corrupted storage', async () => {
    const s = storage(); const key = inventorySnapshotKey(provider)
    await writeInventorySnapshot(s as never, key, models)
    await writeInventorySnapshot(s as never, key, new Map())
    inventorySnapshotTestUtils.reset()
    expect(await readInventorySnapshot(s as never, key)).toEqual(new Map())
    s.values.set(key, { version: 1, models: [{ id: 'broken' }] })
    inventorySnapshotTestUtils.reset()
    expect(await readInventorySnapshot(s as never, key)).toBeUndefined()
  })
})
