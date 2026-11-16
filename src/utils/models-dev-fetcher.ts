export interface ModelsDevModel {
  id: string
  name?: string
  attachment?: boolean
  reasoning?: boolean
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
const PREFIX_MATCH_MIN_SCORE = 70
const PREFIX_MATCH_MIN_SHARED_PARTS = 2

const modelsDevCaches = new Map<string, Map<string, ModelsDevModel>>()

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

export async function fetchModelsDevData(url: string = DEFAULT_MODELS_DEV_URL): Promise<Map<string, ModelsDevModel>> {
  const cached = modelsDevCaches.get(url)
  if (cached) return cached

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    })

    if (!response.ok) {
      return new Map()
    }

    const models = parseModelsDevData(await response.json())
    modelsDevCaches.set(url, models)
    return models
  } catch {
    return new Map()
  }
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
): ModelsDevModel | undefined {
  const requestedModelLower = modelId.toLowerCase()
  const exactModelMatches = allCandidates.filter(([candidateModel]) => candidateModel === requestedModelLower)
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
    if (exactModelMatch) return exactModelMatch
  }

  return findBestPrefixMatch(variants, allCandidates)
}

export const modelsDevTestUtils = {
  parseModelsDevData,
  resetCache(): void {
    modelsDevCaches.clear()
  },
}
