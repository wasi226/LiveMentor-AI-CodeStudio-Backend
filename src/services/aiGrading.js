/**
 * AI Grading Service
 * Uses Gemini to estimate solution correctness when strict test-case grading is inconclusive.
 */

import logger from '../utils/logger.js';
import { callGeminiChat, getGeminiConfig } from './geminiClient.js';
import { evaluateSubmissionLocally } from './localGrading.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const extractJsonBlock = (text) => {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return null;
  }

  const fencedJsonMatch = /```json\s*([\s\S]*?)\s*```/i.exec(normalized);
  if (fencedJsonMatch?.[1]) {
    return fencedJsonMatch[1].trim();
  }

  const fencedMatch = /```\s*([\s\S]*?)\s*```/i.exec(normalized);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return normalized.slice(firstBrace, lastBrace + 1);
  }

  return null;
};

const parseJsonResponse = (rawText) => {
  const candidate = extractJsonBlock(rawText);
  if (!candidate) {
    return null;
  }

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
};

export const evaluateSubmissionWithAI = async ({ assignment, code, language, executionResult }) => {
  const { apiKey } = getGeminiConfig();
  if (!apiKey) {
    return evaluateSubmissionLocally({ assignment, code, language, executionResult });
  }

  const prompt = [
    `Language: ${language || assignment?.language || 'unknown'}`,
    `Assignment title: ${assignment?.title || ''}`,
    `Assignment description: ${assignment?.description || ''}`,
    `Expected test cases count: ${(assignment?.test_cases || []).length}`,
    `Execution summary:`,
    `- Passed tests: ${Number(executionResult?.passedTests) || 0}`,
    `- Total tests: ${Number(executionResult?.totalTests) || 0}`,
    `- Error: ${executionResult?.error || 'none'}`,
    '',
    'Reference solution code (if available):',
    assignment?.solution_code || '(not provided)',
    '',
    'Student submission code:',
    code || '(empty)',
    '',
    'Return ONLY valid JSON with keys:',
    '- scorePercentage: number 0-100 (semantic correctness estimate)',
    '- confidence: one of low|medium|high',
    '- reason: short string'
  ].join('\n');

  const messages = [
    {
      role: 'system',
      content: [
        'You are a strict but fair programming evaluator.',
        'Score semantic correctness, not formatting differences.',
        'If logic appears correct but test mismatch may be due to I/O formatting or minor edge cases, do not return 0.',
        'Return only JSON.'
      ].join(' ')
    },
    {
      role: 'user',
      content: prompt
    }
  ];

  try {
    const { content } = await callGeminiChat({
      messages,
      temperature: 0.1,
      maxTokens: 300
    });

    const parsed = parseJsonResponse(content);
    if (!parsed) {
      return null;
    }

    return {
      scorePercentage: clamp(Number(parsed.scorePercentage) || 0, 0, 100),
      confidence: ['low', 'medium', 'high'].includes(String(parsed.confidence || '').toLowerCase())
        ? String(parsed.confidence).toLowerCase()
        : 'low',
      reason: String(parsed.reason || '').trim()
    };
  } catch (error) {
    logger.warn('Gemini grading unavailable, using offline local grader', {
      message: error.message
    });
    return evaluateSubmissionLocally({ assignment, code, language, executionResult });
  }
};

export default {
  evaluateSubmissionWithAI
};
