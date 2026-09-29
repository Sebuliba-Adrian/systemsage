import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createXai } from '@ai-sdk/xai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/*
 * Every provider here runs through the EXACT same generateObject call, the
 * same LessonStepSchema, and the same system prompt (built from the same
 * shared buildDesignFormatGuide() the MCP server also uses) -- see
 * plan.ts. The only thing that varies is which model is doing the
 * reasoning. That's deliberate: the standing requirement is that quality
 * results from Claude Code or Codex (via the MCP server) must equal
 * quality results from Gemini, DeepSeek, Qwen, or Grok via API key, and
 * the only way to make that a fair test is for every path to run through
 * literally the same pipeline.
 */

export type ProviderId = 'gemini' | 'deepseek' | 'qwen' | 'grok';

export interface ProviderConfig {
  id: ProviderId;
  /** Human-readable name for reports. */
  label: string;
  /** Env var this provider reads its API key from. */
  apiKeyEnvVar: string;
  model: string;
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    model: 'gemini-3.5-flash-lite',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen',
    // DashScope's OpenAI-compatible endpoint -- Qwen has no first-party
    // @ai-sdk provider, this is the real, documented way to reach it.
    apiKeyEnvVar: 'DASHSCOPE_API_KEY',
    model: 'qwen-plus',
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    apiKeyEnvVar: 'XAI_API_KEY',
    model: 'grok-4-fast',
  },
};

/**
 * Checked LIVE, every call -- never cached at module-import time. A
 * process that loads its .env AFTER importing this module (as a script
 * that calls dotenv.config() in its own top-level code does: ES module
 * imports evaluate before the importing file's own code runs) would see a
 * false negative from a value baked in at import time. This bit the
 * comparison script directly during development; fixed here, at the
 * source, rather than by reordering imports in every caller.
 */
export function hasRealKey(providerId: ProviderId): boolean {
  return Boolean(process.env[PROVIDERS[providerId].apiKeyEnvVar]);
}

/**
 * Every provider id is buildable (so the architecture is genuinely
 * pluggable), but calling one with no real key throws immediately and
 * clearly rather than silently falling back to a different provider or
 * producing a fabricated result. See ARCHITECTURE.md: no key exists in
 * this account for Qwen or Grok as of this writing.
 */
export function createModel(providerId: ProviderId): LanguageModel {
  const config = PROVIDERS[providerId];
  const apiKey = process.env[config.apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(
      `No ${config.apiKeyEnvVar} set -- cannot use ${config.label} as a real provider. ` +
        'This is a real, unfulfilled precondition, not a bug: get a key for it before ' +
        'including it in any quality comparison.',
    );
  }

  switch (providerId) {
    case 'gemini':
      return createGoogleGenerativeAI({ apiKey })(config.model);
    case 'deepseek':
      return createDeepSeek({ apiKey })(config.model);
    case 'grok':
      return createXai({ apiKey })(config.model);
    case 'qwen':
      return createOpenAICompatible({
        name: 'qwen',
        apiKey,
        baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      }).chatModel(config.model);
  }
}
