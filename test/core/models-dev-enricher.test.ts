import { describe, expect, it } from 'vitest'
import { createModelsDevEnricher } from '../../src/utils/model-info/models-dev'

describe('native models.dev enricher', () => {
  it('returns neutral metadata without a host-shaped config object', () => {
    const enricher = createModelsDevEnricher(new Map([
      ['openai/gpt-5', {
        id: 'openai/gpt-5',
        name: 'GPT 5',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'] },
        limit: { context: 128_000, output: 16_384 },
      }],
    ]))

    expect(enricher.enrich({ id: 'openai/gpt-5' }, { filterNonChat: true })).toEqual({
      metadataName: 'GPT 5',
      limit: { context: 128_000, output: 16_384 },
      reasoning: true,
      toolCall: true,
      modalities: { input: ['text', 'image'] },
    })
  })

  it('maps v2 reasoning options to effort variants from a separate catalog', () => {
    const enricher = createModelsDevEnricher(
      new Map([
        ['byteplus/deepseek-v4-1-flash-261017', {
          id: 'byteplus/deepseek-v4-1-flash-261017',
          name: 'DeepSeek V4.1 Flash 1017',
          reasoning: true,
          limit: { context: 1_000_000, output: 384_000 },
        }],
      ]),
      new Map([
        ['byteplus/deepseek-v4-1-flash-261017', {
          id: 'byteplus/deepseek-v4-1-flash-261017',
          reasoning: true,
          reasoning_options: [
            { type: 'toggle' },
            { type: 'effort', values: ['low', 'high', 'max'] },
          ],
        }],
      ]),
    )

    expect(enricher.enrich({ id: 'deepseek-v4-1-flash-261017' }, { filterNonChat: true })).toEqual({
      metadataName: 'DeepSeek V4.1 Flash 1017',
      limit: { context: 1_000_000, output: 384_000 },
      reasoning: true,
      variants: {
        low: { reasoningEffort: 'low' },
        high: { reasoningEffort: 'high' },
        max: { reasoningEffort: 'max' },
      },
    })
  })

  it('ignores unsupported effort tiers and missing controls', () => {
    const enricher = createModelsDevEnricher(new Map([
      ['test/reasoner', {
        id: 'test/reasoner',
        reasoning: true,
        reasoning_options: [
          { type: 'toggle' },
          { type: 'effort', values: ['turbo', 'high'] },
        ],
      }],
    ]))

    expect(enricher.enrich({ id: 'reasoner' }, { filterNonChat: true })).toEqual({
      reasoning: true,
      variants: { high: { reasoningEffort: 'high' } },
    })
  })
})
