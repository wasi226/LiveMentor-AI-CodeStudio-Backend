/**
 * Local Offline Grading Service
 * Provides deterministic scoring when Gemini is unavailable or rate-limited.
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'class', 'def', 'do', 'else', 'for', 'function', 'if',
  'in', 'int', 'let', 'main', 'null', 'of', 'public', 'return', 'static', 'string', 'the', 'to', 'var', 'void',
  'while', 'with', 'print', 'println', 'console', 'input', 'read', 'write', 'true', 'false', 'this', 'self'
]);

const INTENT_PATTERNS = [
  { name: 'sum', keywords: ['sum', 'add', 'addition', 'total'], codeHints: ['+', 'sum', 'total', '+='] },
  { name: 'difference', keywords: ['subtract', 'difference', 'minus', 'decrease'], codeHints: ['-', 'subtract', '-='] },
  { name: 'product', keywords: ['multiply', 'product', 'times'], codeHints: ['*', 'multiply', '*='] },
  { name: 'division', keywords: ['divide', 'division', 'quotient'], codeHints: ['/', 'divide', '/='] },
  { name: 'sort', keywords: ['sort', 'sorted', 'ordering', 'arrange'], codeHints: ['sort', 'sorted'] },
  { name: 'reverse', keywords: ['reverse', 'backwards'], codeHints: ['reverse', 'reversed'] },
  { name: 'max', keywords: ['maximum', 'largest', 'max'], codeHints: ['max', 'Math.max', 'maximum'] },
  { name: 'min', keywords: ['minimum', 'smallest', 'min'], codeHints: ['min', 'Math.min', 'minimum'] },
  { name: 'loop', keywords: ['loop', 'iterate', 'iteration'], codeHints: ['for', 'while', 'range', 'each'] },
  { name: 'condition', keywords: ['if', 'condition', 'branch', 'check'], codeHints: ['if', 'else', 'switch', 'case'] }
];

const stripComments = (code, language) => {
  const source = String(code || '');
  const normalizedLanguage = String(language || '').toLowerCase();

  if (normalizedLanguage === 'python') {
    return source
      .replace(/#.*$/gm, '')
      .replace(/'''[\s\S]*?'''/g, '')
      .replace(/"""[\s\S]*?"""/g, '');
  }

  return source
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
};

const normalizeSource = (code, language) => {
  return stripComments(code, language)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
};

const tokenize = (code) => {
  const tokens = String(code || '').match(/[a-z_][a-z0-9_]*|\d+|==|!=|<=|>=|=>|\+\+|--|[+\-*/%=<>()[\]{}.,:]/gi) || [];
  return tokens
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
};

const uniqueTokens = (tokens) => new Set(tokens);

const jaccardSimilarity = (firstTokens, secondTokens) => {
  if (!firstTokens.size || !secondTokens.size) {
    return 0;
  }

  let intersection = 0;
  firstTokens.forEach((token) => {
    if (secondTokens.has(token)) {
      intersection += 1;
    }
  });

  const union = firstTokens.size + secondTokens.size - intersection;
  return union > 0 ? intersection / union : 0;
};

const detectFeatures = (code) => {
  const source = String(code || '').toLowerCase();

  return {
    hasLoop: /\b(for|while|range|each|map|filter)\b/.test(source),
    hasConditional: /\b(if|else|switch|case|elif)\b/.test(source),
    hasFunction: /\b(def|function|=>|public\s+static|private\s+static)\b/.test(source),
    hasCollection: /[\[\]{}]|\b(array|list|dict|map|set)\b/.test(source),
    hasRecursion: /\b([a-z_][a-z0-9_]*)\b[\s\S]*\1\s*\(/i.test(source)
  };
};

const calculateFeatureScore = (studentFeatures, referenceFeatures) => {
  let bonus = 0;

  if (referenceFeatures.hasLoop && studentFeatures.hasLoop) bonus += 8;
  if (referenceFeatures.hasConditional && studentFeatures.hasConditional) bonus += 8;
  if (referenceFeatures.hasFunction && studentFeatures.hasFunction) bonus += 8;
  if (referenceFeatures.hasCollection && studentFeatures.hasCollection) bonus += 6;
  if (referenceFeatures.hasRecursion && studentFeatures.hasRecursion) bonus += 10;

  return bonus;
};

const detectTaskIntentBonus = ({ assignment, code }) => {
  const text = [
    assignment?.title || '',
    assignment?.description || '',
    assignment?.solution_code || ''
  ].join(' ').toLowerCase();
  const source = String(code || '').toLowerCase();

  let bonus = 0;

  for (const pattern of INTENT_PATTERNS) {
    const keywordHit = pattern.keywords.some((keyword) => text.includes(keyword));
    if (!keywordHit) {
      continue;
    }

    const codeHit = pattern.codeHints.some((hint) => source.includes(String(hint).toLowerCase()));
    if (codeHit) {
      bonus += 5;
    }
  }

  return Math.min(bonus, 20);
};

const buildConfidence = (score, similarity, hasSolution) => {
  if (hasSolution && similarity >= 0.75) return 'high';
  if (score >= 70 || similarity >= 0.45) return 'medium';
  return 'low';
};

const buildReason = ({ score, similarity, executionResult, hasSolution, taskBonus }) => {
  const parts = [];

  if (!String(executionResult?.error || '').trim()) {
    parts.push('Code executed without a clear runtime failure.');
  } else {
    parts.push('Execution reported issues, so local scoring relied on structural similarity.');
  }

  if (hasSolution) {
    parts.push(`Compared with reference solution similarity ${(similarity * 100).toFixed(0)}%.`);
  } else {
    parts.push('No reference solution was available, so scoring used assignment intent and code structure.');
  }

  if (taskBonus > 0) {
    parts.push('Task-specific keywords and code patterns matched expected intent.');
  }

  parts.push(`Assigned offline score ${score}%.`);
  return parts.join(' ');
};

export const evaluateSubmissionLocally = ({ assignment, code, language, executionResult }) => {
  const sourceCode = String(code || '').trim();
  if (!sourceCode) {
    return {
      scorePercentage: 0,
      confidence: 'low',
      reason: 'Empty submission.'
    };
  }

  const maxAttempts = Number(executionResult?.totalTests) || (assignment?.test_cases || []).length;
  const passedTests = Number(executionResult?.passedTests) || 0;
  const testCoverage = maxAttempts > 0 ? passedTests / maxAttempts : 0;

  const normalizedStudent = normalizeSource(sourceCode, language);
  const normalizedSolution = normalizeSource(assignment?.solution_code || '', language);
  const hasSolution = normalizedSolution.length > 0;

  const studentTokens = uniqueTokens(tokenize(normalizedStudent));
  const solutionTokens = uniqueTokens(tokenize(normalizedSolution));
  const similarity = hasSolution ? jaccardSimilarity(studentTokens, solutionTokens) : 0;

  const studentFeatures = detectFeatures(normalizedStudent);
  const solutionFeatures = hasSolution ? detectFeatures(normalizedSolution) : null;

  let score = 35;

  if (executionResult?.success && testCoverage > 0) {
    score = 60 + Math.round(testCoverage * 30);
  } else if (executionResult?.error) {
    score = 28;
  } else if (executionResult?.passedTests > 0) {
    score = 45 + Math.round(testCoverage * 30);
  }

  if (hasSolution) {
    const similarityScore = Math.round(similarity * 55);
    score = Math.max(score, 30 + similarityScore);

    if (solutionFeatures) {
      score += calculateFeatureScore(studentFeatures, solutionFeatures);
    }
  } else {
    score += studentFeatures.hasFunction ? 5 : 0;
    score += studentFeatures.hasConditional ? 5 : 0;
    score += studentFeatures.hasLoop ? 5 : 0;
    score += studentFeatures.hasCollection ? 5 : 0;
  }

  const taskBonus = detectTaskIntentBonus({ assignment, code: sourceCode });
  score += taskBonus;

  if (passedTests > 0 && maxAttempts > 0) {
    score += Math.round((passedTests / maxAttempts) * 15);
  }

  if (!executionResult?.error && hasSolution && similarity >= 0.7) {
    score += 10;
  }

  const finalScore = clamp(Math.round(score), 25, 95);
  const confidence = buildConfidence(finalScore, similarity, hasSolution);
  const reason = buildReason({
    score: finalScore,
    similarity,
    executionResult,
    hasSolution,
    taskBonus
  });

  return {
    scorePercentage: finalScore,
    confidence,
    reason
  };
};

export default {
  evaluateSubmissionLocally
};
