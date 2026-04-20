/**
 * Secure Code Execution Service using Piston API
 * Handles code compilation and execution in sandboxed environments
 */

import axios from 'axios';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const DEFAULT_PISTON_EXECUTE_URL = 'https://emkc.org/api/v2/piston/execute';

function getExecutionConfig() {
  return {
    apiUrl: normalizePistonApiUrl(process.env.PISTON_API_URL || DEFAULT_PISTON_EXECUTE_URL),
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
}

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
    const executionConfig = getExecutionConfig();
    const normalizedLanguage = String(language || '').toLowerCase();
    const runtimeConfig = LANGUAGE_CONFIGS[normalizedLanguage];

    if (!runtimeConfig) {
      throw new Error(`Unsupported language: ${language}`);
    }

    const preparedCode = prepareSourceCode(code, normalizedLanguage);

    if (!executionConfig.apiUrl) {
      logger.warn('PISTON_API_URL not configured, using fallback execution service');
      return await fallbackExecution({ code: preparedCode, language: normalizedLanguage, input, testCases });
    }

    if (testCases.length === 0) {
      try {
        return await executeSingleRun({
          code: preparedCode,
          runtimeConfig,
          input,
          executionConfig
        });
      } catch (executionError) {
        if (executionError?.code === 'PISTON_AUTH') {
          logger.warn('Piston authorization unavailable, using fallback execution service');
          return await fallbackExecution({ code: preparedCode, language: normalizedLanguage, input, testCases });
        }

        throw executionError;
      }
    }

    try {
      return await executeTestCases({
        code: preparedCode,
        runtimeConfig,
        testCases,
        executionConfig
      });
    } catch (executionError) {
      if (executionError?.code === 'PISTON_AUTH') {
        logger.warn('Piston authorization unavailable, using fallback execution service for test-case run');
        return await fallbackExecution({ code: preparedCode, language: normalizedLanguage, input, testCases });
      }

      throw executionError;
    }
  } catch (error) {
    const executionConfig = getExecutionConfig();
    logger.error('Code execution failed:', error);
    return {
      success: false,
      error: error.message,
      output: '',
      executionTime: 0,
      memoryUsage: 0,
      testResults: [],
      provider: executionConfig.apiUrl ? 'piston' : 'fallback'
    };
  }
}

async function executeSingleRun({ code, runtimeConfig, input, executionConfig }) {
  try {
    const headers = buildPistonHeaders();
    const requestUrl = `${executionConfig.apiUrl}/execute`;
    const requestPayload = buildPistonPayload({ code, runtimeConfig, input, executionConfig });

    console.log('[PISTON] Request:', {
      url: requestUrl,
      language: runtimeConfig.runtime,
      version: runtimeConfig.version,
      hasAuthorization: Boolean(headers.Authorization),
      inputLength: String(input || '').length,
      codeLength: String(code || '').length
    });

    const response = await axios.post(
      requestUrl,
      requestPayload,
      {
        headers,
        timeout: executionConfig.requestTimeout
      }
    );

    console.log('[PISTON] Response:', {
      status: response.status,
      language: response.data?.language,
      version: response.data?.version,
      hasCompileStage: Boolean(response.data?.compile),
      hasRunStage: Boolean(response.data?.run)
    });

    return formatPistonResponse(response.data);
  } catch (error) {
    console.error('[PISTON] Error:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      responseData: error.response?.data
    });

    if (error.response?.status === 401 || error.response?.status === 403) {
      const authorizationError = new Error('Piston authorization failed');
      authorizationError.code = 'PISTON_AUTH';
      throw authorizationError;
    }

    throw new Error(getPistonErrorMessage(error, executionConfig));
  }
}

async function executeTestCases({ code, runtimeConfig, testCases, executionConfig }) {
  const testResults = [];
  let firstResult = null;

  for (const [index, testCase] of testCases.entries()) {
    const result = await executeSingleRun({
      code,
      runtimeConfig,
      input: testCase.input || '',
      executionConfig
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

function buildPistonPayload({ code, runtimeConfig, input, executionConfig }) {
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
    compile_timeout: executionConfig.compileTimeout,
    run_timeout: executionConfig.runTimeout,
    compile_cpu_time: executionConfig.compileCpuTime,
    run_cpu_time: executionConfig.runCpuTime,
    compile_memory_limit: executionConfig.compileMemoryLimit,
    run_memory_limit: executionConfig.runMemoryLimit
  };
}

function buildPistonHeaders() {
  const headers = {
    'Content-Type': 'application/json'
  };

  const token = sanitizeToken(process.env.PISTON_API_TOKEN);

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function sanitizeToken(tokenValue) {
  if (tokenValue === undefined || tokenValue === null) {
    return '';
  }

  const trimmed = String(tokenValue).trim();

  if (!trimmed || trimmed === '""' || trimmed === "''") {
    return '';
  }

  return trimmed;
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

function getPistonErrorMessage(error, executionConfig) {
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
    return `Unable to reach Piston API at ${executionConfig?.apiUrl || 'unknown URL'}.`;
  }

  return `Piston API request failed: ${apiMessage}`;
}

function normalizePistonApiUrl(url) {
  const normalizedUrl = (url || '').replace(/\/+$/, '');

  if (normalizedUrl.endsWith('/execute')) {
    return normalizedUrl.slice(0, -('/execute'.length));
  }

  return normalizedUrl;
}

function prepareSourceCode(code, language) {
  const source = String(code || '');

  if (language !== 'java') {
    return source;
  }

  // Piston executes Java code from Main.java by default in this service.
  // Rename common classroom template class names so student code runs without file-name mismatch errors.
  if (/\bpublic\s+class\s+Main\b/.test(source) || /\bclass\s+Main\b/.test(source)) {
    return source;
  }

  if (/\bpublic\s+class\s+\w+\b/.test(source)) {
    return source.replace(/\bpublic\s+class\s+\w+\b/, 'public class Main');
  }

  if (/\bclass\s+\w+\b/.test(source)) {
    return source.replace(/\bclass\s+\w+\b/, 'class Main');
  }

  return source;
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
  logger.info(`Using local fallback execution service for ${language}`);

  if (testCases.length > 0) {
    return executeLocalTestCases({ code, language, testCases });
  }

  return executeLocalSingleRun({ code, language, input });
}

async function executeLocalTestCases({ code, language, testCases }) {
  const testResults = [];
  let firstResult = null;

  for (const [index, testCase] of testCases.entries()) {
    const result = await executeLocalSingleRun({
      code,
      language,
      input: testCase.input || ''
    });

    if (!firstResult) {
      firstResult = result;
    }

    const actualOutput = String(result.rawOutput || result.output || '').trim();
    const expectedOutput = String(testCase.expectedOutput || '').trim();
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
      status: passed ? 'Accepted' : 'Wrong Answer'
    });
  }

  const passedTests = testResults.filter((result) => result.passed).length;
  const totalTests = testResults.length;
  const score = totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 0;
  const primaryResult = firstResult || {
    success: false,
    output: '',
    error: 'No test cases executed.',
    executionTime: 0,
    memoryUsage: 0,
    status: 'failed',
    provider: 'fallback-local'
  };

  return {
    success: passedTests === totalTests && totalTests > 0,
    output: primaryResult.output,
    error: primaryResult.error,
    executionTime: Math.max(...testResults.map((result) => result.executionTime || 0), primaryResult.executionTime || 0),
    memoryUsage: Math.max(...testResults.map((result) => result.memoryUsage || 0), primaryResult.memoryUsage || 0),
    testResults,
    score,
    passedTests,
    totalTests,
    provider: 'fallback-local',
    status: passedTests === totalTests ? 'completed' : 'tests_failed'
  };
}

async function executeLocalSingleRun({ code, language, input }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lm-exec-'));
  const startedAt = process.hrtime.bigint();

  try {
    const runtimePlan = getLocalRuntimePlan(language, tempDir);
    if (!runtimePlan) {
      return {
        success: false,
        output: '',
        rawOutput: '',
        error: `Local fallback does not support language: ${language}. Configure PISTON_API_URL and PISTON_API_TOKEN for remote execution.`,
        executionTime: 0,
        memoryUsage: 0,
        testResults: [],
        status: 'unsupported_language',
        provider: 'fallback-local'
      };
    }

    await fs.writeFile(runtimePlan.sourceFilePath, code, 'utf8');

    if (runtimePlan.compile) {
      const compileResult = await runLocalCommand({
        command: runtimePlan.compile.command,
        args: runtimePlan.compile.args,
        cwd: tempDir,
        input: '',
        timeoutMs: DEFAULT_COMPILE_TIMEOUT
      });

      if (!compileResult.success) {
        const executionTime = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        return {
          success: false,
          output: compileResult.stdout,
          rawOutput: compileResult.stdout,
          error: compileResult.error,
          executionTime,
          memoryUsage: 0,
          testResults: [],
          status: 'compilation_failed',
          provider: 'fallback-local'
        };
      }
    }

    const runResult = await runLocalCommand({
      command: runtimePlan.run.command,
      args: runtimePlan.run.args,
      cwd: tempDir,
      input,
      timeoutMs: DEFAULT_RUN_TIMEOUT
    });

    const executionTime = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const hasRuntimeError = runResult.success === false;
    const outputText = runResult.stdout || '';

    return {
      success: runResult.success,
      output: hasRuntimeError ? outputText : (outputText || 'Program executed successfully (no output)'),
      rawOutput: outputText,
      error: hasRuntimeError ? runResult.error : '',
      executionTime,
      memoryUsage: 0,
      testResults: [],
      status: hasRuntimeError ? 'runtime_failed' : 'completed',
      provider: 'fallback-local'
    };
  } catch (error) {
    const executionTime = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    return {
      success: false,
      output: '',
      rawOutput: '',
      error: error.message || 'Local fallback execution failed',
      executionTime,
      memoryUsage: 0,
      testResults: [],
      status: 'failed',
      provider: 'fallback-local'
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function getLocalRuntimePlan(language, tempDir) {
  switch (language) {
    case 'javascript':
      return {
        sourceFilePath: path.join(tempDir, 'main.js'),
        run: { command: process.execPath, args: ['main.js'] }
      };
    case 'python':
      return {
        sourceFilePath: path.join(tempDir, 'main.py'),
        run: { command: 'python', args: ['main.py'] }
      };
    case 'java':
      return {
        sourceFilePath: path.join(tempDir, 'Main.java'),
        compile: { command: 'javac', args: ['Main.java'] },
        run: { command: 'java', args: ['-cp', tempDir, 'Main'] }
      };
    default:
      return null;
  }
}

function runLocalCommand({ command, args, cwd, input, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({
          success: false,
          stdout,
          error: 'Time limit exceeded'
        });
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      const notInstalled = error.code === 'ENOENT';

      resolve({
        success: false,
        stdout,
        error: notInstalled
          ? `Runtime not available: ${command} is not installed or not in PATH.`
          : (error.message || stderr || 'Execution error')
      });
    });

    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      const success = exitCode === 0;
      resolve({
        success,
        stdout,
        error: success ? '' : (stderr.trim() || `Process exited with code ${exitCode}`)
      });
    });

    if (input) {
      child.stdin.write(String(input));
    }
    child.stdin.end();
  });
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