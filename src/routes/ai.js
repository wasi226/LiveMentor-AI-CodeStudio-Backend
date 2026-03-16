/**
 * AI Routes
 * Handles OpenAI-backed coding assistant functionality.
 */

import express from 'express';
import Joi from 'joi';
import { validateBody } from '../middleware/validation.js';
import logger from '../utils/logger.js';

const router = express.Router();

const aiSchemas = {
  assistant: Joi.object({
    message: Joi.string().min(1).max(4000).required(),
    code: Joi.string().allow('').max(120000).default(''),
    language: Joi.string().allow('').default('javascript'),
    history: Joi.array().items(
      Joi.object({
        role: Joi.string().valid('user', 'assistant').required(),
        content: Joi.string().max(8000).required()
      })
    ).default([])
  })
};

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const getOpenAIConfig = () => ({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  temperature: Number.parseFloat(process.env.OPENAI_TEMPERATURE || '0.7'),
  maxTokens: Number.parseInt(process.env.OPENAI_MAX_TOKENS || '1000', 10)
});

const buildMessages = ({ userQuestion, code, language, history }) => {
  const safeHistory = Array.isArray(history)
    ? history.slice(-8).map((msg) => ({
      role: msg.role,
      content: msg.content
    }))
    : [];

  const systemPrompt = [
    'You are a programming tutor in liveMentor AI CodeStudio.',
    'Focus on debugging, clear explanations, and actionable next steps.',
    'When relevant, suggest minimal code fixes and explain why they work.',
    'If code is provided, reason about that code context first.'
  ].join(' ');

  const userPrompt = [
    `Language: ${language || 'unknown'}`,
    'Question:',
    userQuestion,
    '',
    'Current code:',
    code || '(no code provided)'
  ].join('\n');

  return [
    { role: 'system', content: systemPrompt },
    ...safeHistory,
    { role: 'user', content: userPrompt }
  ];
};

router.post('/assistant', validateBody(aiSchemas.assistant), async (req, res) => {
  try {
    const { message, code, language, history } = req.body;
    const { apiKey, model, temperature, maxTokens } = getOpenAIConfig();

    if (!apiKey) {
      return res.status(503).json({
        success: false,
        error: 'AI assistant is not configured on the server. Set OPENAI_API_KEY to enable it.'
      });
    }

    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: buildMessages({
          userQuestion: message,
          code,
          language,
          history
        })
      })
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      logger.error('OpenAI assistant request failed', {
        status: response.status,
        payload
      });

      return res.status(response.status).json({
        success: false,
        error: payload?.error?.message || payload?.message || 'OpenAI request failed.'
      });
    }

    const assistantResponse = payload?.choices?.[0]?.message?.content?.trim();

    if (!assistantResponse) {
      return res.status(502).json({
        success: false,
        error: 'OpenAI returned an empty assistant response.'
      });
    }

    res.json({
      success: true,
      response: assistantResponse,
      model: payload.model,
      usage: payload.usage || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('AI assistant route error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process AI assistant request.'
    });
  }
});

router.get('/health', (req, res) => {
  const { apiKey, model } = getOpenAIConfig();

  res.json({
    status: apiKey ? 'configured' : 'missing_api_key',
    model,
    timestamp: new Date().toISOString()
  });
});

export default router;