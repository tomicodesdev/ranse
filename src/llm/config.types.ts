import { z } from 'zod';

export const Provider = z.enum([
  'workers-ai',
  'openai',
  'anthropic',
  'google-ai-studio',
  'grok',
  'openrouter',
  'cerebras',
]);
export type Provider = z.infer<typeof Provider>;

export const ModelSpec = z.object({
  provider: Provider,
  contextSize: z.number().int().positive(),
  nonReasoning: z.boolean().optional(),
  directOverride: z.boolean().optional(),
  supportsTools: z.boolean().default(true),
  supportsJsonSchema: z.boolean().default(true),
});
export type ModelSpec = z.infer<typeof ModelSpec>;

export const MODELS_MASTER: Record<string, ModelSpec> = {
  'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast': {
    provider: 'workers-ai',
    contextSize: 128_000,
    nonReasoning: true,
    // directOverride was true here previously but that pointed the OpenAI SDK
    // at AI Gateway's /workers-ai endpoint, which is Cloudflare's native API
    // shape — not OpenAI chat.completions. Routing through /compat instead
    // lets the gateway translate the OpenAI-format request to Workers AI.
    supportsTools: true,
    supportsJsonSchema: true,
  },
  'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct': {
    provider: 'workers-ai',
    contextSize: 128_000,
    nonReasoning: true,
    supportsTools: true,
    supportsJsonSchema: true,
  },
  'openai/gpt-4o': { provider: 'openai', contextSize: 128_000, nonReasoning: true, supportsTools: true, supportsJsonSchema: true },
  'openai/gpt-4o-mini': { provider: 'openai', contextSize: 128_000, nonReasoning: true, supportsTools: true, supportsJsonSchema: true },
  'openai/gpt-5': { provider: 'openai', contextSize: 400_000, supportsTools: true, supportsJsonSchema: true },
  'openai/gpt-5-mini': { provider: 'openai', contextSize: 400_000, supportsTools: true, supportsJsonSchema: true },
  'anthropic/claude-opus-4-7': { provider: 'anthropic', contextSize: 1_000_000, supportsTools: true, supportsJsonSchema: true },
  'anthropic/claude-sonnet-4-6': { provider: 'anthropic', contextSize: 1_000_000, supportsTools: true, supportsJsonSchema: true },
  'anthropic/claude-haiku-4-5': { provider: 'anthropic', contextSize: 200_000, nonReasoning: true, supportsTools: true, supportsJsonSchema: true },
  'google-ai-studio/gemini-2.5-pro': { provider: 'google-ai-studio', contextSize: 1_000_000, supportsTools: true, supportsJsonSchema: true },
  'google-ai-studio/gemini-2.5-flash': { provider: 'google-ai-studio', contextSize: 1_000_000, nonReasoning: true, supportsTools: true, supportsJsonSchema: true },
};

export type ActionKey =
  | 'triage'
  | 'summarize'
  | 'draft'
  | 'knowledge_query'
  | 'escalation'
  | 'conversational';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ModelConfig {
  model: string;
  fallbackModel?: string;
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  maxTokens?: number;
}

export type AgentConfig = Record<ActionKey, ModelConfig>;

export interface RuntimeOverrides {
  userApiKeys?: Partial<Record<Provider, string>>;
  aiGateway?: { baseUrl: string; token: string };
}

export interface CallMetadata {
  workspaceId: string;
  ticketId?: string;
  userId?: string;
  actionKey: ActionKey;
}
