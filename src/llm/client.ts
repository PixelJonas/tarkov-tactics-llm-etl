// Provider-agnostic LLM client
// Supports: Anthropic, OpenAI, OpenRouter, Ollama-style endpoints

export interface LLMConfig {
  apiBase: string;
  model: string;
  apiKey: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
}

function getLLMConfig(): LLMConfig | null {
  const apiBase = process.env.LLM_API_BASE;
  const model = process.env.LLM_MODEL;
  const apiKey = process.env.LLM_API_KEY;

  if (!apiBase || !model || !apiKey) {
    return null;
  }

  return { apiBase, model, apiKey };
}

export function isLLMConfigured(): boolean {
  return getLLMConfig() !== null;
}

export async function callLLM(messages: LLMMessage[]): Promise<LLMResponse> {
  const config = getLLMConfig();
  if (!config) {
    throw new Error('LLM is not configured. Set LLM_API_BASE, LLM_MODEL, and LLM_API_KEY.');
  }

  const isAnthropic = config.apiBase.includes('anthropic');

  if (isAnthropic) {
    return callAnthropic(config, messages);
  }

  // Default to OpenAI-compatible API (works for OpenAI, OpenRouter, Ollama)
  return callOpenAICompatible(config, messages);
}

async function callAnthropic(config: LLMConfig, messages: LLMMessage[]): Promise<LLMResponse> {
  const systemMessage = messages.find(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: 4096,
    temperature: 0,
    messages: nonSystemMessages.map(m => ({
      role: m.role,
      content: m.content,
    })),
  };

  if (systemMessage) {
    body.system = systemMessage.content;
  }

  const response = await fetch(`${config.apiBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const result = (await response.json()) as { content?: Array<{ text?: string }> };
  const content = result.content?.[0]?.text || '';

  return {
    content,
    model: `anthropic:${config.model}`,
  };
}

async function callOpenAICompatible(config: LLMConfig, messages: LLMMessage[]): Promise<LLMResponse> {
  const response = await fetch(`${config.apiBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      temperature: 0,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API error ${response.status}: ${text}`);
  }

  const result = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = result.choices?.[0]?.message?.content || '';

  return {
    content,
    model: `${config.apiBase.includes('openrouter') ? 'openrouter' : 'openai'}:${config.model}`,
  };
}

export function getLLMModelIdentifier(): string {
  const config = getLLMConfig();
  if (!config) return 'none';

  const provider = config.apiBase.includes('anthropic')
    ? 'anthropic'
    : config.apiBase.includes('openrouter')
      ? 'openrouter'
      : config.apiBase.includes('localhost') || config.apiBase.includes('127.0.0.1')
        ? 'ollama'
        : 'openai-compatible';

  return `${provider}:${config.model}`;
}