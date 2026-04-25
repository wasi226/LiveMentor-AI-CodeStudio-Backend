/**
 * Gemini Client Service
 * Shared Google AI Studio (Gemini) integration for chat-style responses.
 */

import logger from '../utils/logger.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export const getGeminiConfig = () => ({
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
  temperature: Number.parseFloat(process.env.GEMINI_TEMPERATURE || '0.7'),
  maxTokens: Number.parseInt(process.env.GEMINI_MAX_TOKENS || '1000', 10)
});

const normalizeRole = (role) => {
  if (role === 'assistant' || role === 'model') {
    return 'model';
  }

  return 'user';
};

const getGeminiTextFromPayload = (payload) => {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return '';
  }

  return parts
    .map((part) => String(part?.text || '').trim())
    .filter(Boolean)
    .join('\n');
};

export const callGeminiChat = async ({ messages, temperature, maxTokens }) => {
  const { apiKey, model, temperature: defaultTemperature, maxTokens: defaultMaxTokens } = getGeminiConfig();

  if (!apiKey) {
    const error = new Error('Gemini API key is not configured. Set GEMINI_API_KEY.');
    error.statusCode = 503;
    throw error;
  }

  const safeMessages = Array.isArray(messages) ? messages : [];
  const systemMessages = safeMessages.filter((message) => message?.role === 'system');
  const conversationMessages = safeMessages.filter((message) => message?.role !== 'system');

  const systemInstructionText = systemMessages
    .map((message) => String(message?.content || '').trim())
    .filter(Boolean)
    .join('\n\n');

  const contents = conversationMessages
    .map((message) => ({
      role: normalizeRole(message?.role),
      parts: [{ text: String(message?.content || '') }]
    }))
    .filter((item) => String(item.parts?.[0]?.text || '').trim().length > 0);

  if (contents.length === 0) {
    contents.push({
      role: 'user',
      parts: [{ text: 'Hello' }]
    });
  }

  const payloadBody = {
    contents,
    generationConfig: {
      temperature: Number.isFinite(temperature) ? temperature : defaultTemperature,
      maxOutputTokens: Number.isInteger(maxTokens) ? maxTokens : defaultMaxTokens
    }
  };

  if (systemInstructionText) {
    payloadBody.systemInstruction = {
      parts: [{ text: systemInstructionText }]
    };
  }

  const requestUrl = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payloadBody)
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || payload?.message || 'Gemini request failed.'
    );
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }

  const content = getGeminiTextFromPayload(payload);
  if (!content) {
    logger.warn('Gemini returned empty content', {
      model,
      payloadKeys: Object.keys(payload || {})
    });
  }

  return {
    payload,
    content,
    model
  };
};

export default {
  callGeminiChat,
  getGeminiConfig
};
