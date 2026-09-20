import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/random.js';

const log = logger.child('ai');

/**
 * AI layer.
 *
 * IMPORTANT: the model never decides eligibility. Eligibility is computed by the
 * deterministic policy engine; the model is handed the *facts* and asked to
 * explain them in plain language. If no provider is configured (the default for
 * the demo) TravelGuard falls back to its own deterministic narration templates,
 * so the product behaves identically offline.
 */
export async function generateNarrative({ facts, fallback, maxWords = 90 }) {
  const startedAt = Date.now();

  if (config.ai.provider === 'template' || !config.ai.apiKey) {
    await sleep(240); // keep the "reasoning" state visible for the presenter
    return {
      text: fallback,
      generatedBy: 'TravelGuard Decision Layer',
      mode: 'deterministic narration',
      latencyMs: Date.now() - startedAt,
      confidence: facts.confidence ?? 0.94,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        temperature: 0.2,
        max_tokens: 260,
        messages: [
          {
            role: 'system',
            content:
              `You are the explanation layer of TravelGuard AI, a travel-disruption concierge. ` +
              `Explain ONLY the facts in the JSON payload. Never invent flights, prices, times or policies. ` +
              `Use British English, be warm, concrete and confident. Maximum ${maxWords} words.`,
          },
          { role: 'user', content: JSON.stringify(facts) },
        ],
      }),
    });

    if (!response.ok) throw new Error(`LLM responded ${response.status}`);
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty completion');

    return {
      text,
      generatedBy: `LLM · ${config.ai.model}`,
      mode: 'llm narration',
      latencyMs: Date.now() - startedAt,
      confidence: facts.confidence ?? 0.94,
    };
  } catch (error) {
    log.warn(`falling back to deterministic narration: ${error.message}`);
    return {
      text: fallback,
      generatedBy: 'TravelGuard Decision Layer',
      mode: 'deterministic narration (LLM unavailable)',
      latencyMs: Date.now() - startedAt,
      confidence: facts.confidence ?? 0.9,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const aiStatus = () => ({
  provider: config.ai.provider,
  model: config.ai.provider === 'openai' ? config.ai.model : 'deterministic templates',
  configured: Boolean(config.ai.apiKey) && config.ai.provider !== 'template',
  role: 'explanation + prioritisation only — eligibility stays deterministic',
});
