import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import type { DiscoveredV2Model } from './catalog.js'
import type { CatalogProvider } from './discovery.js'
import type { ProviderDiscoveryOptions } from './provider-config.js'

const pending = new Map<string, Promise<unknown>>()
function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!record(value)) return value
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]))
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
function projection(model: DiscoveredV2Model): Record<string, unknown> {
  // Only schema-supported metadata, never provider credentials/headers/bodies.
  return {
    modelID: model.modelID, name: model.name,
    limit: model.limit,
    capabilities: {
      tools: model.capabilities.tools, input: model.capabilities.input, output: model.capabilities.output,
      ...(typeof model.reasoning === 'boolean' ? { reasoning: { supported: model.reasoning } } : {}),
    },
  }
}
export function persistedConfigPath(options: NonNullable<ProviderDiscoveryOptions['persistModels']>, directory?: string): string {
  const resolvePath = (value: string): string => {
    if (value === '~') return homedir()
    if (value.startsWith('~/')) return resolve(homedir(), value.slice(2))
    return isAbsolute(value) ? value : resolve(directory ?? process.cwd(), value)
  }
  const configured = options.path ?? process.env.OPENCODE_CONFIG
  if (configured) return resolvePath(configured)
  return resolvePath(join(process.env.OPENCODE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode'), 'opencode.jsonc'))
}

function update(text: string, provider: CatalogProvider, models: ReadonlyMap<string, DiscoveredV2Model>): string {
  const errors: ParseError[] = []
  const doc: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !record(doc)) throw new Error('Refusing to modify invalid JSONC configuration')
  const target = doc.providers?.[provider.id]
  if (!record(target) || target.settings?.modelsDiscovery?.persistModels?.enabled !== true) {
    throw new Error('Target file must enable persistModels for this provider')
  }
  if (target.package !== provider.package || target.settings?.baseURL !== provider.settings.baseURL) {
    throw new Error('Target provider package/baseURL changed; refusing stale discovery write')
  }
  // A stale refresh must not write after discovery filters or credentials changed.
  const expected = provider.settings.modelsDiscovery
  const actual = target.settings.modelsDiscovery
  const withoutOwnership = (value: any) => {
    if (!record(value)) return value
    const copy = structuredClone(value)
    if (record(copy.persistModels)) delete copy.persistModels.managedModels
    return copy
  }
  if (fingerprint(withoutOwnership(actual)) !== fingerprint(withoutOwnership(expected)) ||
    target.settings?.apiKey !== provider.settings.apiKey || target.settings?.integrationID !== provider.settings.integrationID) {
    throw new Error('Target discovery settings or credentials changed; refusing stale discovery write')
  }
  if (target.models !== undefined && !record(target.models)) throw new Error('Provider models must be an object')
  const existing = target.models ?? {}
  const ownership = actual.persistModels.managedModels
  if (ownership !== undefined && !record(ownership)) throw new Error('Managed-model ownership must be an object')
  const managed: Record<string, string> = ownership ?? {}
  const nextManaged: Record<string, string> = {}
  const edits: Array<[Array<string>, unknown]> = []
  const modelPath = ['providers', provider.id, 'models']
  for (const [id, model] of models) {
    const current = existing[id]
    // Existing manual entries and edited generated entries remain user-owned.
    if (current !== undefined && (!Object.hasOwn(managed, id) || fingerprint(current) !== managed[id])) continue
    const desired = projection(model)
    nextManaged[id] = fingerprint(desired)
    if (current === undefined || fingerprint(current) !== nextManaged[id]) edits.push([[...modelPath, id], desired])
  }
  for (const [id, hash] of Object.entries(managed)) {
    if (!models.has(id) && Object.hasOwn(existing, id) && fingerprint(existing[id]) === hash) edits.push([[...modelPath, id], undefined])
  }
  if (fingerprint(managed) !== fingerprint(nextManaged)) {
    edits.push([['providers', provider.id, 'settings', 'modelsDiscovery', 'persistModels', 'managedModels'], nextManaged])
  }
  const indentation = text.match(/\n([\t ]+)"/)?.[1] ?? '  '
  for (const [path, value] of edits) {
    text = applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: !indentation.includes('\t'), tabSize: indentation.length, eol: text.includes('\r\n') ? '\r\n' : '\n' } }))
  }
  return text
}

/** Call only for a successful discovered inventory, after applying overrides. */
export async function persistConfigModels(file: string, provider: CatalogProvider, models: ReadonlyMap<string, DiscoveredV2Model>): Promise<boolean> {
  const canonicalPath = await fs.realpath(file)
  const previous = pending.get(canonicalPath) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    let text = await fs.readFile(canonicalPath, 'utf8')
    if (update(text, provider, models) === text) return false
    // No lock files or temp files are touched for a no-op, avoiding watcher loops.
    const lockPath = `${canonicalPath}.models-discovery.lock`
    const lock = await fs.open(lockPath, 'wx', 0o600)
    const temporary = join(dirname(canonicalPath), `.models-discovery-${randomUUID()}.tmp`)
    try {
      text = await fs.readFile(canonicalPath, 'utf8')
      const next = update(text, provider, models)
      if (next === text) return false
      const stat = await fs.stat(canonicalPath)
      const output = await fs.open(temporary, 'wx', stat.mode & 0o777)
      try { await output.writeFile(next, 'utf8'); await output.sync() } finally { await output.close() }
      if (await fs.readFile(canonicalPath, 'utf8') !== text) throw new Error('Configuration changed during write; retry on next refresh')
      await fs.rename(temporary, canonicalPath)
      return true
    } finally {
      await fs.unlink(temporary).catch(() => {})
      await lock.close()
      await fs.unlink(lockPath)
    }
  })
  pending.set(canonicalPath, operation)
  try { return await operation } finally { if (pending.get(canonicalPath) === operation) pending.delete(canonicalPath) }
}
