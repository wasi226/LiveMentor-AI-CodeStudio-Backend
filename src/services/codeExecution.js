/**
 * Secure Code Execution Service using Piston API
 * Handles code compilation and execution in sandboxed environments
 */

import axios from 'axios';
import logger from '../utils/logger.js';

export const LANGUAGE_CONFIGS = {
  javascript: { runtime: 'javascript', version: '*', fileName: 'main.js', displayName: 'JavaScript' },
  python: { runtime: 'python', version: '*', fileName: 'main.py', displayName: 'Python' },
  java: { runtime: 'java', version: '*', fileName: 'Main.java', displayName: 'Java' },
  cpp: { runtime: 'c++', version: '*', fileName: 'main.cpp', displayName: 'C++' },
  c: { runtime: 'c', version: '*', fileName: 'main.c', displayName: 'C' },
  typescript: { runtime: 'typescript', version: '*', fileName: 'main.ts', displayName: 'TypeScript' },
  go: { runtime: 'go', version: '*', fileName: 'main.go', displayName: 'Go' },
  rust: { runtime: 'rust', version: '*', fileName: 'main.rs', displayName: 'Rust' },
  php: { runtime: 'php', version: '*', fileName: 'main.php', displayName: 'PHP' },
  ruby: { runtime: 'ruby', version: '*', fileName: 'main.rb', displayName: 'Ruby' },
  csharp: { runtime: 'csharp', version: '*', fileName: 'Program.cs', displayName: 'C#' },
  kotlin: { runtime: 'kotlin', version: '*', fileName: 'Main.kt', displayName: 'Kotlin' },
  swift: { runtime: 'swift', version: '*', fileName: 'main.swift', displayName: 'Swift' },
  scala: { runtime: 'scala', version: '*', fileName: 'Main.scala', displayName: 'Scala' }
};

const DEFAULT_REQUEST_TIMEOUT = 15000;
const DEFAULT_COMPILE_TIMEOUT = 10000;
const DEFAULT_RUN_TIMEOUT = 5000;
const DEFAULT_RUN_MEMORY_LIMIT = 128 * 1024 * 1024;
const DEFAULT_COMPILE_MEMORY_LIMIT = 256 * 1024 * 1024;

const EXECUTION_CONFIG = {
  apiUrl: normalizePistonApiUrl(process.env.PISTON_API_URL),
  requestTimeout: parseInteger(process.env.PISTON_REQUEST_TIMEOUT, DEFAULT_REQUEST_TIMEOUT),
  compileTimeout: parseInteger(process.env.PISTON_COMPILE_TIMEOUT, DEFAULT_COMPILE_TIMEOUT),
  runTimeout: parseInteger(process.env.PISTON_RUN_TIMEOUT, DEFAULT_RUN_TIMEOUT),
  compileCpuTime: parseInteger(
    process.env.PISTON_COMPILE_CPU_TIME,
    parseInteger(process.env.PISTON_COMPILE_TIMEOUT, DEFAULT_COMPILE_TIMEOUT)
  ),
  runCpuTime: parseInteger(
    process.env.PISTON_RUN_CPU_TIME,
    parseInteger(process.env.PISTON_RUN_TIMEOUT, DEFAULT_RUN_TIMEOUT)
  ),
  compileMemoryLimit: parseInteger(process.env.PISTON_COMPILE_MEMORY_LIMIT, DEFAULT_COMPILE_MEMORY_LIMIT),
  runMemoryLimit: parseInteger(
    process.env.PISTON_RUN_MEMORY_LIMIT,
    parseLegacyJudge0Memory(process.env.JUDGE0_MAX_MEMORY, DEFAULT_RUN_MEMORY_LIMIT)
  )
};

/**
 * Execute code using Piston API
 * @param {Object} params - Execution parameters
 * @param {string} params.code - Source code to execute
 * @param {string} params.language - Programming language
 * @param {string} params.input - Input data for the program
 * @param {Array} params.testCases - Test cases for validation
 * @returns {Promise<Object>} Execution results
 */
export async function executeCode({
  code,
  language,
  input = '',
  testCases = []
}) {
  try {
    const runtimeConfig = LANGUAGE_CONFIGS[language.toLowerCase()];

    if (!runtimeConfig) {
      throw new Error(`Unsupported language: ${language}`);
    }

    if (!EXECUTION_CONFIG.apiUrl) {
      logger.warn('PISTON_API_URL not configured, using fallback execution service');
      return await fallbackExecution({ code, language, input, testCases });
    }

    if (testCases.length === 0) {
      return await executeSingleRun({
        code,
        runtimeConfig,
        input
      });
    }

    return await executeTestCases({
      code,
      runtimeConfig,
      testCases
    });
  } catch (error) {
    logger.error('Code execution failed:', error);
    return {
      success: false,
      error: error.message,
      output: '',
      executionTime: 0,
      memoryUsage: 0,
      testResults: [],
      provider: EXECUTION_CONFIG.apiUrl ? 'piston' : 'fallback'
    };
  }
}

async function executeSingleRun({ code, runtimeConfig, input }) {
  try {
    const response = await axios.post(
      `${EXECUTION_CONFIG.apiUrl}/execute`,
      buildPistonPayload({ code, runtimeConfig, input }),
      {
        headers: buildPistonHeaders(),
        timeout: EXECUTION_CONFIG.requestTimeout
      }
    );

    return formatPistonResponse(response.data);
  } catch (error) {
    throw new Error(getPistonErrorMessage(error));
  }
}

async function executeTestCases({ code, runtimeConfig, testCases }) {
  const testResults = [];
  let firstResult = null;

  for (const [index, testCase] of testCases.entries()) {
    const result = await executeSingleRun({
      code,
      runtimeConfig,
      input: testCase.input || ''
    });

    if (!firstResult) {
      firstResult = result;
    }

    const actualOutput = (result.rawOutput || '').trim();
    const expectedOutput = (testCase.expectedOutput || '').trim();
    const passed = result.success && actualOutput === expectedOutput;

    testResults.push({
      testCaseIndex: index,
      passed,
      input: testCase.input || '',
      expectedOutput,
      actualOutput,
      error: result.error,
      executionTime: result.executionTime,
      memoryUsage: result.memoryUsage,
      status: result.status
    });
  }

  const passedTests = testResults.filter(result => result.passed).length;
  const totalTests = testResults.length;
  const score = totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 0;
  const primaryResult = firstResult || {
    output: '',
    error: '',
    executionTime: 0,
    memoryUsage: 0,
    provider: 'piston',
    status: 'completed'
  };

  return {
    success: passedTests > 0,
    output: primaryResult.output,
    error: primaryResult.error,
    executionTime: Math.max(...testResults.map(result => result.executionTime || 0), primaryResult.executionTime || 0),
    memoryUsage: Math.max(...testResults.map(result => result.memoryUsage || 0), primaryResult.memoryUsage || 0),
    testResults,
    score,
    passedTests,
    totalTests,
    provider: primaryResult.provider,
    status: passedTests === totalTests ? 'completed' : 'tests_failed'
  };
}

function buildPistonPayload({ code, runtimeConfig, input }) {
  return {
    language: runtimeConfig.runtime,
    version: runtimeConfig.version,
    files: [
      {
        name: runtimeConfig.fileName,
        content: code
      }
    ],
    stdin: input,
    compile_timeout: EXECUTION_CONFIG.compileTimeout,
    run_timeout: EXECUTION_CONFIG.runTimeout,
    compile_cpu_time: EXECUTION_CONFIG.compileCpuTime,
    run_cpu_time: EXECUTION_CONFIG.runCpuTime,
    compile_memory_limit: EXECUTION_CONFIG.compileMemoryLimit,
    run_memory_limit: EXECUTION_CONFIG.runMemoryLimit
  };
}

function buildPistonHeaders() {
  const headers = {
    'Content-Type': 'application/json'
  };

  const token = process.env.PISTON_API_TOKEN;

  if (token) {
    const headerName = process.env.PISTON_API_AUTH_HEADER || 'Authorization';
    const authScheme = process.env.PISTON_API_AUTH_SCHEME;
    headers[headerName] = authScheme ? `${authScheme} ${token}` : token;
  }

  return headers;
}

function formatPistonResponse(responseData) {
  const compileStage = responseData.compile || null;
  const runStage = responseData.run || null;
  const compileFailed = stageFailed(compileStage);
  const runFailed = stageFailed(runStage);
  const success = !compileFailed && !runFailed;
  const rawOutput = runStage?.stdout || '';
  const warningText = success
    ? [compileStage?.stderr, runStage?.stderr].filter(Boolean).map(text => text.trim()).filter(Boolean).join('\n\n')
    : '';

  const outputSections = [];

  if (rawOutput.trim()) {
    outputSections.push(rawOutput);
  }

  if (warningText) {
    outputSections.push(`Warnings:\n${warningText}`);
  }

  return {
    success,
    output: success ? outputSections.join('\n\n') || 'Program executed successfully (no output)' : rawOutput,
    rawOutput,
    error: success ? '' : formatExecutionError(compileStage, runStage),
    executionTime: Math.max(Number(compileStage?.wall_time) || 0, Number(runStage?.wall_time) || 0),
    memoryUsage: Math.max(Number(compileStage?.memory) || 0, Number(runStage?.memory) || 0),
    status: success ? 'completed' : getFailureStatus(compileStage, runStage),
    testResults: [],
    provider: 'piston',
    version: responseData.version,
    runtimeLanguage: responseData.language
  };
}

function stageFailed(stage) {
  if (!stage) {
    return false;
  }

  return Boolean(
    stage.code !== 0 ||
    stage.signal ||
    stage.message ||
    stage.status
  );
}

function formatExecutionError(compileStage, runStage) {
  if (stageFailed(compileStage)) {
    return formatStageError('Compilation', compileStage);
  }

  if (stageFailed(runStage)) {
    return formatStageError('Execution', runStage);
  }

  return 'Execution failed';
}

function formatStageError(label, stage) {
  const details = [];
  const translatedStatus = translateStageStatus(stage?.status);

  if (translatedStatus) {
    details.push(translatedStatus);
  }

  if (stage?.message) {
    details.push(stage.message);
  }

  if (stage?.stderr?.trim()) {
    details.push(stage.stderr.trim());
  }

  if (stage?.signal) {
    details.push(`Signal: ${stage.signal}`);
  }

  if (stage?.code !== undefined && stage?.code !== null && stage.code !== 0) {
    details.push(`Exit code: ${stage.code}`);
  }

  const uniqueDetails = [...new Set(details.filter(Boolean))];

  return uniqueDetails.length > 0
    ? `${label} failed\n${uniqueDetails.join('\n')}`
    : `${label} failed`;
}

function getFailureStatus(compileStage, runStage) {
  const failingStage = stageFailed(compileStage) ? compileStage : runStage;
  return translateStageStatus(failingStage?.status) || failingStage?.message || 'failed';
}

function translateStageStatus(status) {
  switch (status) {
    case 'TO':
      return 'Time limit exceeded';
    case 'RE':
      return 'Runtime error';
    case 'SG':
      return 'Process terminated by signal';
    case 'OL':
      return 'Standard output limit exceeded';
    case 'EL':
      return 'Standard error limit exceeded';
    case 'XX':
      return 'Internal execution service error';
    default:
      return status || '';
  }
}

function getPistonErrorMessage(error) {
  const statusCode = error.response?.status;
  const apiMessage = error.response?.data?.message || error.response?.data?.error || error.message;

  if (statusCode === 401 || statusCode === 403) {
    return 'Piston API authorization failed. Set PISTON_API_TOKEN for the public API or use a self-hosted Piston instance.';
  }

  if (statusCode === 400) {
    return `Piston request rejected: ${apiMessage}`;
  }

  if (error.code === 'ECONNABORTED') {
    return 'Piston request timed out before the execution service responded.';
  }

  if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
    return `Unable to reach Piston API at ${EXECUTION_CONFIG.apiUrl}.`;
  }

  return `Piston API request failed: ${apiMessage}`;
}

function normalizePistonApiUrl(url) {
  return (url || '').replace(/\/+$/, '');
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseLegacyJudge0Memory(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed * 1024;
}

/**
 * Fallback execution service for development/testing
 */
async function fallbackExecution({ code, language, input, testCases }) {
  logger.info('Using fallback execution service (development mode)');

  await new Promise(resolve => setTimeout(resolve, 1000));

  const mockResults = {
    success: true,
    output: `Mock execution result for ${language}\nCode length: ${code.length} characters\nInput: ${input || 'none'}`,
    error: '',
    executionTime: Math.random() * 100,
    memoryUsage: Math.floor(Math.random() * 10000),
    testResults: [],
    provider: 'fallback'
  };

  if (testCases.length > 0) {
    mockResults.testResults = testCases.map((testCase, index) => ({
      testCaseIndex: index,
      passed: Math.random() > 0.3,
      input: testCase.input || '',
      expectedOutput: testCase.expectedOutput || '',
      actualOutput: testCase.expectedOutput || 'mock output',
      error: Math.random() > 0.8 ? 'Mock runtime error' : '',
      executionTime: Math.random() * 50,
      memoryUsage: Math.floor(Math.random() * 5000),
      status: 'Accepted'
    }));

    const passedTests = mockResults.testResults.filter(testResult => testResult.passed).length;
    mockResults.passedTests = passedTests;
    mockResults.totalTests = testCases.length;
    mockResults.score = Math.round((passedTests / testCases.length) * 100);
  }

  return mockResults;
}

export function getSupportedLanguages() {
  return Object.entries(LANGUAGE_CONFIGS).map(([name, config]) => ({
    name,
    id: config.runtime,
    runtime: config.runtime,
    version: config.version,
    displayName: config.displayName
  }));
}

export function validateCode(code, language) {
  const errors = [];

  if (!code || code.trim().length === 0) {
    errors.push('Code cannot be empty');
  }

  if (code.length > 65000) {
    errors.push('Code is too long (maximum 65KB)');
  }

  if (!LANGUAGE_CONFIGS[language.toLowerCase()]) {
    errors.push(`Unsupported language: ${language}`);
  }

  switch (language.toLowerCase()) {
    case 'python':
      if (code.includes('import os') || code.includes('import subprocess')) {
        errors.push('System imports are not allowed for security reasons');
      }
      break;
    case 'javascript':
      if (code.includes('require("fs")') || code.includes('require("child_process")')) {
        errors.push('System modules are not allowed for security reasons');
      }
      break;
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

export default {
  executeCode,
  getSupportedLanguages,
  validateCode,
  LANGUAGE_CONFIGS
};