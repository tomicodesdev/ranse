import { describe, it, expect } from 'vitest';
import { parseModel } from '../src/llm/core';
import { DEFAULT_AGENT_CONFIG } from '../src/llm/config';
import { MODELS_MASTER } from '../src/llm/config.types';

describe('parseModel', () => {
  it('splits "provider/model-id" correctly', () => {
    const { provider, modelId, spec } = parseModel('anthropic/claude-sonnet-4-6');
    expect(provider).toBe('anthropic');
    expect(modelId).toBe('claude-sonnet-4-6');
    expect(spec.supportsTools).toBe(true);
  });

  it('handles workers-ai nested paths', () => {
    const { provider, modelId } = parseModel(
      'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    );
    expect(provider).toBe('workers-ai');
    expect(modelId).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  });

  it('throws for unknown models', () => {
    expect(() => parseModel('madeup/model-x')).toThrow(/Unknown model/);
  });
});

describe('MODELS_MASTER', () => {
  it('every entry has a provider matching the key prefix', () => {
    for (const [key, spec] of Object.entries(MODELS_MASTER)) {
      expect(key.startsWith(`${spec.provider}/`), `${key} prefix != ${spec.provider}`).toBe(true);
    }
  });

  it('workers-ai entries do NOT set directOverride (gateway /compat handles them)', () => {
    // Earlier the assumption was that Workers AI needed the direct gateway
    // endpoint, but empirically /workers-ai is Cloudflare's native API
    // shape — not OpenAI chat.completions. We route Workers AI through
    // /compat (same as every other provider) and pass the full
    // workers-ai/<model> name so the gateway dispatches correctly.
    for (const [key, spec] of Object.entries(MODELS_MASTER)) {
      if (spec.provider === 'workers-ai') {
        expect(spec.directOverride ?? false, `${key} must NOT set directOverride`).toBe(false);
      }
    }
  });
});

describe('DEFAULT_AGENT_CONFIG', () => {
  it('every agent action has a default model registered in MODELS_MASTER', () => {
    for (const [action, cfg] of Object.entries(DEFAULT_AGENT_CONFIG)) {
      expect(MODELS_MASTER[cfg.model], `${action}.model missing from registry`).toBeDefined();
      if (cfg.fallbackModel) {
        expect(
          MODELS_MASTER[cfg.fallbackModel],
          `${action}.fallbackModel missing from registry`,
        ).toBeDefined();
      }
    }
  });
});
