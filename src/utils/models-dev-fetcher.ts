export type ModelsDevReasoningOption =
  | { readonly type: 'toggle' }
  | { readonly type: 'effort'; readonly values: string[] }
  | { readonly type: 'budget_tokens'; readonly min?: number; readonly max?: number }

export interface ModelsDevModel {
  id: string
  name?: string
  attachment?: boolean
  reasoning?: boolean
  reasoning_options?: ModelsDevReasoningOption[]
  tool_call?: boolean
  structured_output?: boolean
  temperature?: boolean
  modalities?: {
    input?: string[]
    output?: string[]
  }
  limit?: {
    context?: number
    input?: number
    output?: number
  }
}

export const DEFAULT_MODELS_DEV_URL = 'https://models.dev/models.json'
/**
 * models.dev's v2 catalog exposes reasoning controls (`toggle`, `effort`,
 * `budget_tokens`) as `reasoning_options`. The flat legacy feed used for model
 * metadata does not carry them, so they are fetched separately and merged only
 * when a single provider can be identified.
 */
export const DEFAULT_MODELS_DEV_REASONING_URL = 'https://models.dev/api.json'
const PREFIX_MATCH_MIN_SCORE = 70
const PREFIX_MATCH_MIN_SHARED_PARTS = 2
const MODELS_DEV_TIMEOUT_MS = 3000
const MODELS_DEV_REASONING_TIMEOUT_MS = 5000

const modelsDevCaches = new Map<string, Map<string, ModelsDevModel>>()
const modelsDevReasoningCaches = new Map<string, Map<string, ModelsDevModel>>()

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function addReasoningOption(options: ModelsDevReasoningOption[], value: unknown): void {
  if (!isObject(value) || typeof value.type !== 'string') return
  if (value.type === 'toggle') {
    options.push({ type: 'toggle' })
    return
  }
  if (value.type === 'effort') {
    const values = Array.isArray(value.values)
      ? value.values.filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
      : []
    if (values.length > 0) options.push({ type: 'effort', values })
    return
  }
  if (value.type === 'budget_tokens') {
    options.push({
      type: 'budget_tokens',
      ...(typeof value.min === 'number' && Number.isFinite(value.min) ? { min: value.min } : {}),
      ...(typeof value.max === 'number' && Number.isFinite(value.max) ? { max: value.max } : {}),
    })
  }
}

function parseReasoningOptions(value: unknown): ModelsDevReasoningOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options: ModelsDevReasoningOption[] = []
  for (const item of value) addReasoningOption(options, item)
  return options.length > 0 ? options : undefined
}

function toModelId(providerId: string | undefined, modelId: string): string {
  return providerId ? `${providerId}/${modelId}` : modelId
}

function addModel(cache: Map<string, ModelsDevModel>, providerId: string | undefined, rawModel: Record<string, any>, fallbackModelId?: string): void {
  const rawId = typeof rawModel.id === 'string' && rawModel.id.length > 0 ? rawModel.id : fallbackModelId
  if (!rawId) {
    return
  }

  const id = rawId.includes('/') ? rawId : toModelId(providerId, rawId)
  cache.set(id, {
    id,
    name: typeof rawModel.name === 'string' ? rawModel.name : undefined,
    attachment: typeof rawModel.attachment === 'boolean' ? rawModel.attachment : undefined,
    reasoning: typeof rawModel.reasoning === 'boolean' ? rawModel.reasoning : undefined,
    reasoning_options: parseReasoningOptions(rawModel.reasoning_options),
    tool_call: typeof rawModel.tool_call === 'boolean' ? rawModel.tool_call : undefined,
    structured_output: typeof rawModel.structured_output === 'boolean' ? rawModel.structured_output : undefined,
    temperature: typeof rawModel.temperature === 'boolean' ? rawModel.temperature : undefined,
    modalities: isObject(rawModel.modalities) ? {
      input: Array.isArray(rawModel.modalities.input) ? rawModel.modalities.input.filter((item: unknown): item is string => typeof item === 'string') : undefined,
      output: Array.isArray(rawModel.modalities.output) ? rawModel.modalities.output.filter((item: unknown): item is string => typeof item === 'string') : undefined,
    } : undefined,
    limit: isObject(rawModel.limit) ? {
      context: typeof rawModel.limit.context === 'number' ? rawModel.limit.context : undefined,
      input: typeof rawModel.limit.input === 'number' ? rawModel.limit.input : undefined,
      output: typeof rawModel.limit.output === 'number' ? rawModel.limit.output : undefined,
    } : undefined,
  })
}

function parseModelsDevData(data: unknown): Map<string, ModelsDevModel> {
  const cache = new Map<string, ModelsDevModel>()

  if (!isObject(data)) {
    return cache
  }

  for (const [key, value] of Object.entries(data)) {
    if (!isObject(value)) {
      continue
    }

    if (isObject(value.models)) {
      for (const [modelId, model] of Object.entries(value.models)) {
        if (isObject(model)) {
          addModel(cache, key, model, modelId)
        }
      }
      continue
    }

    addModel(cache, undefined, value, key)
  }

  return cache
}

async function fetchModelsDevCache(
  url: string,
  timeoutMs: number,
  caches: Map<string, Map<string, ModelsDevModel>>,
): Promise<Map<string, ModelsDevModel>> {
  const cached = caches.get(url)
  if (cached) return cached

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      return new Map()
    }

    const models = parseModelsDevData(await response.json())
    caches.set(url, models)
    return models
  } catch {
    return new Map()
  }
}

export function fetchModelsDevData(url: string = DEFAULT_MODELS_DEV_URL): Promise<Map<string, ModelsDevModel>> {
  return fetchModelsDevCache(url, MODELS_DEV_TIMEOUT_MS, modelsDevCaches)
}

/**
 * Fetches models.dev's v2 catalog for reasoning controls. Best-effort: an
 * unreachable or malformed feed degrades to "no reasoning options".
 */
export function fetchModelsDevReasoningData(url: string = DEFAULT_MODELS_DEV_REASONING_URL): Promise<Map<string, ModelsDevModel>> {
  return fetchModelsDevCache(url, MODELS_DEV_REASONING_TIMEOUT_MS, modelsDevReasoningCaches)
}

function splitModelId(modelId: string): { provider?: string; model: string } {
  const parts = modelId.split('/')
  if (parts.length <= 1) {
    return { model: modelId }
  }

  return {
    provider: parts[0].toLowerCase(),
    model: parts.slice(1).join('/'),
  }
}

/**
 * Generates lookup variants for a model id segment so that provider-specific
 * spellings still find the canonical models.dev entry, for example:
 *
 * - `deepseek-v4-1-flash-261017` -> `deepseek-v4.1-flash-1017`
 * - `claude-opus-4-5` -> `claude-opus-4.5`
 * - `grok-build-latest` -> `grok-build`
 *
 * Variants are ordered from least to most transformed, and the original id is
 * always tried first, so normalization can only add matches that the raw id
 * would otherwise miss.
 */
function generateModelIdVariants(modelId: string): string[] {
  const variants: string[] = []
  const add = (value: string): void => {
    if (value.length > 0 && !variants.includes(value)) {
      variants.push(value)
    }
  }

  const transforms: Array<(value: string) => string> = [
    // Version separators: `v4-1` -> `v4.1`, `opus-4-5` -> `opus-4.5`.
    // Lookarounds keep date suffixes such as `glm-4-7-251222` intact.
    (value) => value.replace(/(?<![\d.])(\d{1,2})-(\d{1,2})(?![\d.])/g, '$1.$2'),
    (value) => value.replace(/(?<![\d.])(\d{1,2})\.(\d{1,2})(?![\d.])/g, '$1-$2'),
    // BytePlus-style compact dates: `-261017` -> `-1017`.
    (value) => value.replace(/-(26)(\d{4})(?!\d)/g, '-$2'),
    (value) => value.replace(/-latest$/i, ''),
  ]

  add(modelId)
  for (const transform of transforms) {
    add(transform(modelId))
  }

  const firstLevel = variants.slice(1)
  for (const variant of firstLevel) {
    for (const transform of transforms) {
      add(transform(variant))
    }
  }

  return variants
}

function findExactModelMatch(
  modelId: string,
  allCandidates: ReadonlyArray<[string, ModelsDevModel]>
): ModelsDevModel | null | undefined {
  const requestedModelLower = modelId.toLowerCase()
  const exactModelMatches = allCandidates.filter(([candidateModel]) => candidateModel === requestedModelLower)
  if (exactModelMatches.length > 1) return null
  return exactModelMatches.length === 1 ? exactModelMatches[0]?.[1] : undefined
}

function findBestPrefixMatch(
  modelIds: readonly string[],
  allCandidates: ReadonlyArray<[string, ModelsDevModel]>
): ModelsDevModel | undefined {
  let bestMatch: ModelsDevModel | undefined
  let bestScore = 0
  let bestScoreMatches = 0

  for (const modelId of modelIds) {
    const requestedModelLower = modelId.toLowerCase()
    for (const [candidateModel, value] of allCandidates) {
      const score = calculatePrefixScore(requestedModelLower, candidateModel)
      if (score < PREFIX_MATCH_MIN_SCORE) {
        continue
      }
      if (score > bestScore) {
        bestScore = score
        bestMatch = value
        bestScoreMatches = 1
      } else if (score === bestScore && value !== bestMatch) {
        bestScoreMatches++
      }
    }
  }

  return bestScoreMatches === 1 ? bestMatch : undefined
}

function calculatePrefixScore(modelA: string, modelB: string): number {
  const partsA = modelA.split('-')
  const partsB = modelB.split('-')
  const shorter = partsA.length <= partsB.length ? partsA : partsB
  const longer = partsA.length <= partsB.length ? partsB : partsA

  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) {
      return 0
    }
  }

  if (shorter.length < PREFIX_MATCH_MIN_SHARED_PARTS) {
    return 0
  }

  return Math.max(0, 100 - ((longer.length - shorter.length) * 10))
}

export function lookupModelsDevData(
  modelId: string,
  cache: Map<string, ModelsDevModel>
): ModelsDevModel | undefined {
  let cleanId = modelId.replace(/:[a-zA-Z0-9_-]+$/g, '')
  const parts = cleanId.split('/')
  if (parts.length > 2) {
    cleanId = parts.slice(-2).join('/')
  }

  const originalExactMatch = cache.get(cleanId) ?? cache.get(cleanId.toLowerCase())
  if (originalExactMatch) return originalExactMatch

  const { provider, model } = splitModelId(cleanId)
  const allCandidates: Array<[string, ModelsDevModel]> = []

  for (const [key, value] of cache.entries()) {
    const candidate = splitModelId(key)
    const candidateModelLower = candidate.model.toLowerCase()
    allCandidates.push([candidateModelLower, value])
  }

  const variants = generateModelIdVariants(model)

  for (const variant of variants) {
    const fullVariant = provider ? `${provider}/${variant}` : variant
    const exactMatch = cache.get(fullVariant) ?? cache.get(fullVariant.toLowerCase())
    if (exactMatch) return exactMatch
  }

  for (const variant of variants) {
    const exactModelMatch = findExactModelMatch(variant, allCandidates)
    if (exactModelMatch !== undefined) return exactModelMatch ?? undefined
  }

  return findBestPrefixMatch(variants, allCandidates)
}

/**
 * Resolves reasoning controls from the v2 catalog for a discovered model id.
 *
 * Provider-scoped matches win. Otherwise a bare model id is only accepted when
 * exactly one provider advertises it, or when every provider advertises the
 * same controls. That avoids sending an effort tier the configured provider may
 * not accept.
 */
export function lookupModelsDevReasoningOptions(
  modelId: string,
  cache: Map<string, ModelsDevModel>,
): ModelsDevReasoningOption[] | undefined {
  if (cache.size === 0) return undefined

  let cleanId = modelId.replace(/:[a-zA-Z0-9_-]+$/g, '')
  const parts = cleanId.split('/')
  if (parts.length > 2) cleanId = parts.slice(-2).join('/')

  const { provider, model } = splitModelId(cleanId)
  const variants = generateModelIdVariants(model)

  for (const variant of variants) {
    const fullVariant = provider ? `${provider}/${variant}` : variant
    const match = cache.get(fullVariant) ?? cache.get(fullVariant.toLowerCase())
    if (match?.reasoning_options?.length) return match.reasoning_options
  }

  const candidates = [...cache.entries()].map(([key, value]) => [splitModelId(key).model.toLowerCase(), value] as const)
  for (const variant of variants) {
    const requested = variant.toLowerCase()
    const matches = candidates.filter(([candidate]) => candidate === requested)
    if (matches.length === 0) continue
    const options = matches.map(([, match]) => match.reasoning_options)
    const first = options[0]
    if (!first?.length) continue
    if (options.every((candidate) => JSON.stringify(candidate) === JSON.stringify(first))) return first
  }

  return undefined
}

export const modelsDevTestUtils = {
  parseModelsDevData,
  resetCache(): void {
    modelsDevCaches.clear()
    modelsDevReasoningCaches.clear()
  },
}
