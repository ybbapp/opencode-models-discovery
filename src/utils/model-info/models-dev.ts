import {
  lookupModelsDevData,
  lookupModelsDevReasoningOptions,
  type ModelsDevModel,
  type ModelsDevReasoningOption,
} from '../models-dev-fetcher'
import type { ModelEnricher } from '../../core/model-enrichment'
import { createModelLimits } from '../../core/model-types'

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function hasUsableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function reasoningVariants(
  options: ModelsDevReasoningOption[] | undefined,
): Record<string, { reasoningEffort: string }> | undefined {
  const effort = options?.find((option) => option.type === 'effort')
  if (!effort || effort.type !== 'effort') return undefined

  const variants: Record<string, { reasoningEffort: string }> = {}
  for (const tier of effort.values) {
    const normalized = tier.trim().toLowerCase()
    if (REASONING_EFFORTS.has(normalized)) variants[normalized] = { reasoningEffort: normalized }
  }
  return Object.keys(variants).length > 0 ? variants : undefined
}

export function createModelsDevEnricher(data: unknown, reasoningData?: unknown): ModelEnricher {
  const cache = data instanceof Map ? data as Map<string, ModelsDevModel> : new Map<string, ModelsDevModel>()
  const reasoningCache = reasoningData instanceof Map
    ? reasoningData as Map<string, ModelsDevModel>
    : undefined

  return {
    enrich(model) {
      const info = lookupModelsDevData(model.id, cache)
      const contextLimit = hasUsableNumber(info?.limit?.context) ? info?.limit?.context : info?.limit?.input
      const limits = hasUsableNumber(contextLimit)
        ? createModelLimits(contextLimit, info?.limit?.output, info?.limit?.input)
        : undefined
      const options = info?.reasoning_options?.length
        ? info.reasoning_options
        : reasoningCache
          ? lookupModelsDevReasoningOptions(model.id, reasoningCache)
          : undefined
      const variants = reasoningVariants(options)

      return {
        metadataName: info?.name,
        ...(limits ? { limit: limits } : {}),
        ...(typeof info?.attachment === 'boolean' ? { attachment: info.attachment } : {}),
        ...(typeof info?.reasoning === 'boolean' ? { reasoning: info.reasoning } : {}),
        ...(typeof info?.tool_call === 'boolean' ? { toolCall: info.tool_call } : {}),
        ...(typeof info?.structured_output === 'boolean' ? { structuredOutput: info.structured_output } : {}),
        ...(typeof info?.temperature === 'boolean' ? { temperature: info.temperature } : {}),
        ...(info?.modalities ? { modalities: info.modalities } : {}),
        ...(variants ? { variants, reasoning: true } : {}),
      }
    },
  }
}
