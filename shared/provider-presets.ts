/**
 * The OpenAI-compatible endpoints people actually point this at.
 *
 * The studio talks to one provider at a time — whatever `gatewayURL` names — so
 * "choosing a provider" is choosing an address (and the environment variable
 * that carries its key). These are the base URLs, which differ mostly by a
 * trailing `/v1`, and getting that wrong is the usual reason a configured key
 * "does not work": the request goes to the wrong path and comes back 404.
 *
 * Ordered by how often they come up, not alphabetically: the first entry is the
 * one a new deployment most likely wants.
 * @module provider-presets
 */

export interface ProviderPreset {
  /** Stable id, used as the `<select>` value. */
  readonly id: string
  /** What the settings page shows. */
  readonly label: string
  /** Base of the chat-completions API; `/chat/completions` is appended. */
  readonly baseURL: string
  /** The environment variable the key is usually kept in. */
  readonly keyEnv: string
  /** One line of context: local or hosted, and anything surprising. */
  /** Locale key of the one-line note the settings page shows beside the picker. */
  readonly noteKey: string
  /** Runs on this machine (the picker says so after the name). */
  readonly local?: boolean
}

/** Local endpoints accept no key at all; the field stays empty for them. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', noteKey: 'imagine.preset.openai' },
  { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', noteKey: 'imagine.preset.openrouter' },
  { id: 'ollama', label: 'Ollama', local: true, baseURL: 'http://127.0.0.1:11434/v1', keyEnv: 'OLLAMA_API_KEY', noteKey: 'imagine.preset.localNoKey' },
  { id: 'google', label: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', noteKey: 'imagine.preset.hostedCompatible' },
  { id: 'groq', label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', noteKey: 'imagine.preset.groq' },
  { id: 'anthropic', label: 'Anthropic', baseURL: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY', noteKey: 'imagine.preset.anthropic' },
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', noteKey: 'imagine.preset.hosted' },
  { id: 'mistral', label: 'Mistral', baseURL: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', noteKey: 'imagine.preset.hosted' },
  { id: 'lmstudio', label: 'LM Studio', local: true, baseURL: 'http://127.0.0.1:1234/v1', keyEnv: 'LMSTUDIO_API_KEY', noteKey: 'imagine.preset.localNoKey' },
  { id: 'llamacpp', label: 'llama.cpp', local: true, baseURL: 'http://127.0.0.1:8080/v1', keyEnv: 'LLAMACPP_API_KEY', noteKey: 'imagine.preset.localNoKey' },
  { id: 'vllm', label: 'vLLM', local: true, baseURL: 'http://127.0.0.1:8000/v1', keyEnv: 'VLLM_API_KEY', noteKey: 'imagine.preset.local' },
  { id: 'xai', label: 'xAI (Grok)', baseURL: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', noteKey: 'imagine.preset.hosted' },
  { id: 'together', label: 'Together', baseURL: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY', noteKey: 'imagine.preset.hosted' },
  { id: 'fireworks', label: 'Fireworks', baseURL: 'https://api.fireworks.ai/inference/v1', keyEnv: 'FIREWORKS_API_KEY', noteKey: 'imagine.preset.hosted' },
  { id: 'cerebras', label: 'Cerebras', baseURL: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY', noteKey: 'imagine.preset.hosted' },
] as const

/**
 * The preset an address belongs to, for a settings page that has to show which
 * provider is configured now.
 * @param url - the configured base URL.
 * @returns the preset, or undefined for an address none of them names.
 */
export function presetFor(url: string): ProviderPreset | undefined {
  const norm = (value: string): string => value.trim().replace(/\/+$/, '').toLowerCase()
  return PROVIDER_PRESETS.find(preset => norm(preset.baseURL) === norm(url))
}
