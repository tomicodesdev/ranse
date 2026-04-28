import type { z } from 'zod';
import type { Env } from '../env';
import { DEFAULT_AGENT_CONFIG } from './config';
import type { ActionKey, AgentConfig, CallMetadata, ModelConfig, RuntimeOverrides } from './config.types';
import { resolveClient } from './core';

export interface InferParams<T extends z.ZodTypeAny = z.ZodTypeAny> {
  env: Env;
  action: ActionKey;
  system: string;
  user: string;
  schema?: T;
  schemaName?: string;
  metadata: Omit<CallMetadata, 'actionKey'>;
  overrides?: RuntimeOverrides;
  workspaceConfig?: Partial<AgentConfig>;
  maxAttempts?: number;
}

export interface InferResult<T = unknown> {
  data: T;
  model: string;
  attempts: number;
  fellBackTo?: string;
}

async function resolveModelConfig(action: ActionKey, workspaceConfig?: Partial<AgentConfig>): Promise<ModelConfig> {
  return { ...DEFAULT_AGENT_CONFIG[action], ...(workspaceConfig?.[action] ?? {}) };
}

async function callOnce<T extends z.ZodTypeAny>(
  params: InferParams<T>,
  modelName: string,
  cfg: ModelConfig,
): Promise<z.infer<T> | string> {
  const meta: CallMetadata = { ...params.metadata, actionKey: params.action };
  const { client, modelId, spec } = await resolveClient({
    env: params.env,
    overrides: params.overrides,
    metadata: meta,
    modelName,
  } as any);

  // /compat endpoint of AI Gateway requires `provider/model` format so it
  // knows which provider to dispatch to. Direct provider endpoints (e.g.
  // /openai with OPENAI_API_KEY) just want the bare model name.
  const apiModelName = spec.directOverride ? modelId : `${spec.provider}/${modelId}`;

  const messages = [
    { role: 'system' as const, content: params.system },
    { role: 'user' as const, content: params.user },
  ];

  if (params.schema && spec.supportsJsonSchema) {
    const { zodResponseFormat } = await import('openai/helpers/zod.mjs');
    const completion = await client.chat.completions.parse({
      model: apiModelName,
      messages,
      temperature: cfg.temperature,
      max_completion_tokens: cfg.maxTokens,
      reasoning_effort: spec.nonReasoning ? undefined : cfg.reasoningEffort,
      response_format: zodResponseFormat(params.schema, params.schemaName ?? params.action),
    } as any);
    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) throw new Error('No parsed output');
    return parsed as z.infer<T>;
  }

  const completion = await client.chat.completions.create({
    model: apiModelName,
    messages,
    temperature: cfg.temperature,
    max_completion_tokens: cfg.maxTokens,
    reasoning_effort: spec.nonReasoning ? undefined : cfg.reasoningEffort,
  } as any);
  const text = completion.choices[0]?.message?.content ?? '';
  if (params.schema) return params.schema.parse(JSON.parse(text));
  return text;
}

export async function infer<T extends z.ZodTypeAny>(params: InferParams<T>): Promise<InferResult<z.infer<T>>>;
export async function infer(params: InferParams<z.ZodTypeAny> & { schema?: undefined }): Promise<InferResult<string>>;
export async function infer(params: InferParams): Promise<InferResult> {
  const cfg = await resolveModelConfig(params.action, params.workspaceConfig);
  const maxAttempts = params.maxAttempts ?? 3;
  const candidates = [cfg.model, cfg.fallbackModel].filter(Boolean) as string[];

  let lastError: unknown;
  let attempts = 0;
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    for (let a = 0; a < maxAttempts; a++) {
      attempts++;
      try {
        const data = await callOnce(params as any, model, cfg);
        return { data, model, attempts, fellBackTo: i > 0 ? model : undefined };
      } catch (err) {
        lastError = err;
        const backoff = 200 * 2 ** a + Math.floor(Math.random() * 100);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastError ?? new Error('infer failed');
}
