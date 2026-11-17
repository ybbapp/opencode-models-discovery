import { createHash } from 'node:crypto'
import type { Plugin } from '@opencode/plugin'
import type { CatalogProvider } from './discovery.js'
import type { DiscoveredV2Model } from './catalog.js'
import { sanitizeSensitiveFields } from '../core/discovery-cache.js'

// Separate from the TTL request cache: a successful inventory remains a fallback
// across setup instances, even when request caching is disabled or expired.
const snapshots = new Map<string, Map<string, DiscoveredV2Model>>()
export const inventorySnapshotTestUtils = { reset: () => snapshots.clear() }
export function inventorySnapshotKey(provider: CatalogProvider, directory?: string): string {
  const identity = JSON.stringify([directory, provider.id, provider.package, provider.settings, provider.apiKey])
  return `inventory:last-success:${createHash('sha256').update(identity).digest('hex')}`
}

function parse(value: unknown): Map<string, DiscoveredV2Model> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entry = value as { version?: unknown; models?: unknown }
  if (entry.version !== 1 || !Array.isArray(entry.models)) return undefined
  const models = new Map<string, DiscoveredV2Model>()
  for (const model of entry.models) {
    if (!model || typeof model !== 'object' || typeof model.id !== 'string' || typeof model.modelID !== 'string' ||
      typeof model.name !== 'string' || !model.capabilities || typeof model.capabilities.tools !== 'boolean' ||
      !Array.isArray(model.capabilities.input) || !model.capabilities.input.every((v: unknown) => typeof v === 'string') ||
      !Array.isArray(model.capabilities.output) || !model.capabilities.output.every((v: unknown) => typeof v === 'string') ||
      !model.limit || !Number.isFinite(model.limit.context) || !Number.isFinite(model.limit.output)) return undefined
    models.set(model.id, model as DiscoveredV2Model)
  }
  return models
}

export async function readInventorySnapshot(storage: Plugin.Context['storage'] | undefined, key: string): Promise<Map<string, DiscoveredV2Model> | undefined> {
  const memory = snapshots.get(key)
  if (memory) return structuredClone(memory)
  try {
    const models = parse(await storage?.get(key))
    if (models) snapshots.set(key, structuredClone(models))
    return models
  } catch { return undefined }
}

export async function writeInventorySnapshot(storage: Plugin.Context['storage'] | undefined, key: string, models: Map<string, DiscoveredV2Model>): Promise<void> {
  const entry = sanitizeSensitiveFields({ version: 1, models: [...models.values()] })
  const safeModels = parse(entry)
  if (!safeModels) return
  // A failed disk write must not discard the prior disk snapshot or fail refresh.
  try { await storage?.set(key, entry as never) } catch { /* Keep the last persisted snapshot. */ }
  snapshots.set(key, structuredClone(safeModels))
}
