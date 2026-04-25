/**
 * AI Routes
 * Handles Gemini-backed coding assistant functionality.
 */

import express from 'express';
import Joi from 'joi';
import { validateBody } from '../middleware/validation.js';
import logger from '../utils/logger.js';
import { callGeminiChat, getGeminiConfig } from '../services/geminiClient.js';

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
  }),
  explain: Joi.object({
    code: Joi.string().min(1).max(120000).required(),
    language: Joi.string().allow('').default('javascript'),
    focus: Joi.string().allow('').max(1200).default('')
  }),
  review: Joi.object({
    code: Joi.string().min(1).max(120000).required(),
    language: Joi.string().allow('').default('javascript'),
    goal: Joi.string().allow('').max(1200).default('')
  }),
  complete: Joi.object({
    code: Joi.string().min(1).max(120000).required(),
    language: Joi.string().allow('').default('javascript'),
    cursorPosition: Joi.number().integer().min(0).default(0),
    userIntent: Joi.string().allow('').max(1200).default('')
  })
};

const ensureApiKeyConfigured = (res) => {
  const { apiKey } = getGeminiConfig();

  if (!apiKey) {
    res.status(503).json({
      success: false,
      error: 'AI assistant is not configured on the server. Set GEMINI_API_KEY to enable it.'
    });
    return false;
  }

  return true;
};

const extractJsonBlock = (text) => {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return null;
  }

  const fencedMatch = /```json\s*([\s\S]*?)\s*```/i.exec(normalized);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const plainFenceMatch = /```\s*([\s\S]*?)\s*```/i.exec(normalized);
  if (plainFenceMatch?.[1]) {
    return plainFenceMatch[1].trim();
  }

  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return normalized.slice(firstBrace, lastBrace + 1);
  }

  return null;
};

const parseJsonResponse = (rawText, fallback = {}) => {
  const jsonCandidate = extractJsonBlock(rawText);
  if (!jsonCandidate) {
    return fallback;
  }

  try {
    return JSON.parse(jsonCandidate);
  } catch {
    return fallback;
  }
};

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
    const { temperature, maxTokens } = getGeminiConfig();

    if (!ensureApiKeyConfigured(res)) {
      return;
    }

    const { payload, content, model } = await callGeminiChat({
      temperature,
      maxTokens,
      messages: buildMessages({
        userQuestion: message,
        code,
        language,
        history
      })
    });

    res.json({
      success: true,
      response: content,
      model,
      usage: payload.usageMetadata || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error?.payload) {
      logger.error('Gemini assistant request failed', {
        status: error.statusCode,
        payload: error.payload
      });

      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || 'Gemini request failed.'
      });
    }

    logger.error('AI assistant route error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process AI assistant request.'
    });
  }
});

router.post('/pair/explain', validateBody(aiSchemas.explain), async (req, res) => {
  try {
    const { code, language, focus } = req.body;

    if (!ensureApiKeyConfigured(res)) {
      return;
    }

    const systemPrompt = [
      'You are an expert programming pair programmer.',
      'Explain code in an educational and concise way.',
      'Respond ONLY valid JSON with keys: summary (string), stepByStep (array of strings), concepts (array of strings), risks (array of strings).',
      'Never include markdown fences or additional text.'
    ].join(' ');

    const userPrompt = [
      `Language: ${language || 'unknown'}`,
      `Focus: ${focus || 'General understanding of behavior and flow.'}`,
      '',
      'Code:',
      code
    ].join('\n');

    const { payload, content, model } = await callGeminiChat({
      temperature: 0.35,
      maxTokens: 900,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    const parsed = parseJsonResponse(content, {
      summary: content,
      stepByStep: [],
      concepts: [],
      risks: []
    });

    res.json({
      success: true,
      data: {
        summary: String(parsed.summary || content),
        stepByStep: Array.isArray(parsed.stepByStep) ? parsed.stepByStep : [],
        concepts: Array.isArray(parsed.concepts) ? parsed.concepts : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks : []
      },
      model,
      usage: payload.usageMetadata || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error?.payload) {
      logger.error('Gemini explain request failed', {
        status: error.statusCode,
        payload: error.payload
      });

      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || 'Gemini explain request failed.'
      });
    }

    logger.error('AI explain route error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate code explanation.'
    });
  }
});

router.post('/pair/review', validateBody(aiSchemas.review), async (req, res) => {
  try {
    const { code, language, goal } = req.body;

    if (!ensureApiKeyConfigured(res)) {
      return;
    }

    const systemPrompt = [
      'You are a senior software engineer doing code review.',
      'Find likely bugs and practical optimization opportunities.',
      'Respond ONLY valid JSON with keys: overview (string), bugs (array of objects), optimizations (array of objects).',
      'Each bug object must include: title, severity, explanation, fixSuggestion.',
      'Each optimization object must include: title, impact, explanation, suggestion.',
      'Never include markdown fences or additional text.'
    ].join(' ');

    const userPrompt = [
      `Language: ${language || 'unknown'}`,
      `Goal: ${goal || 'Detect bugs and provide optimization ideas.'}`,
      '',
      'Code:',
      code
    ].join('\n');

    const { payload, content, model } = await callGeminiChat({
      temperature: 0.25,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    const parsed = parseJsonResponse(content, {
      overview: content,
      bugs: [],
      optimizations: []
    });

    res.json({
      success: true,
      data: {
        overview: String(parsed.overview || content),
        bugs: Array.isArray(parsed.bugs) ? parsed.bugs : [],
        optimizations: Array.isArray(parsed.optimizations) ? parsed.optimizations : []
      },
      model,
      usage: payload.usageMetadata || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error?.payload) {
      logger.error('Gemini review request failed', {
        status: error.statusCode,
        payload: error.payload
      });

      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || 'Gemini review request failed.'
      });
    }

    logger.error('AI review route error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze code for bugs and optimizations.'
    });
  }
});

router.post('/pair/complete', validateBody(aiSchemas.complete), async (req, res) => {
  try {
    const { code, language, cursorPosition, userIntent } = req.body;

    if (!ensureApiKeyConfigured(res)) {
      return;
    }

    const boundedCursor = Number.isInteger(cursorPosition) ? cursorPosition : 0;
    const prefix = code.slice(0, Math.max(0, boundedCursor));
    const suffix = code.slice(Math.max(0, boundedCursor));

    const systemPrompt = [
      'You are an AI pair programmer that provides safe, practical code completion.',
      'You must keep language syntax valid and preserve user style where possible.',
      'Respond ONLY valid JSON with keys: reasoning (string), completedCode (string), nextSteps (array of strings).',
      'completedCode must be the full updated code after applying your best completion.',
      'Never include markdown fences or additional text.'
    ].join(' ');

    const userPrompt = [
      `Language: ${language || 'unknown'}`,
      `User intent: ${userIntent || 'Continue and complete current logic near cursor.'}`,
      `Cursor position (character index): ${Math.max(0, boundedCursor)}`,
      '',
      'Code before cursor:',
      prefix || '(empty)',
      '',
      'Code after cursor:',
      suffix || '(empty)',
      '',
      'Return best full-code completion.'
    ].join('\n');

    const { payload, content, model } = await callGeminiChat({
      temperature: 0.2,
      maxTokens: 1500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    const parsed = parseJsonResponse(content, {
      reasoning: 'Generated a completion suggestion.',
      completedCode: code,
      nextSteps: []
    });

    const completedCode = String(parsed.completedCode || '').trim();

    res.json({
      success: true,
      data: {
        reasoning: String(parsed.reasoning || 'Generated a completion suggestion.'),
        completedCode: completedCode || code,
        nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : []
      },
      model,
      usage: payload.usageMetadata || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error?.payload) {
      logger.error('Gemini completion request failed', {
        status: error.statusCode,
        payload: error.payload
      });

      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || 'Gemini completion request failed.'
      });
    }

    logger.error('AI completion route error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate completion suggestion.'
    });
  }
});

router.get('/health', (req, res) => {
  const { apiKey, model } = getGeminiConfig();

  res.json({
    status: apiKey ? 'configured' : 'missing_api_key',
    model,
    timestamp: new Date().toISOString()
  });
});

export default router;