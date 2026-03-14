/**
 * Secure Code Execution Service using Judge0 API
 * Handles code compilation and execution in sandboxed environments
 */

import axios from 'axios';
import logger from '../utils/logger.js';

// Judge0 Language ID mappings
export const LANGUAGE_IDS = {
  javascript: 63,
  python: 71,
  java: 62,
  cpp: 54,
  c: 50,
  typescript: 74,
  go: 60,
  rust: 73,
  php: 68,
  ruby: 72,
  csharp: 51,
  kotlin: 78,
  swift: 83,
  scala: 81
};

// Default code execution timeouts and limits
const EXECUTION_CONFIG = {
  timeout: parseInt(process.env.JUDGE0_TIMEOUT) || 10000,
  maxCpuTime: parseInt(process.env.JUDGE0_MAX_CPU_TIME) || 5,
  maxMemory: parseInt(process.env.JUDGE0_MAX_MEMORY) || 128000,
  pollInterval: 1000,
  maxPollAttempts: 15
};

/**
 * Execute code using Judge0 API
 * @param {Object} params - Execution parameters
 * @param {string} params.code - Source code to execute
 * @param {string} params.language - Programming language
 * @param {string} params.input - Input data for the program
 * @param {Array} params.testCases - Test cases for validation
 * @returns {Object} Execution results
 */
export async function executeCode({
  code,
  language,
  input = '',
  testCases = []
}) {
  try {
    const languageId = LANGUAGE_IDS[language.toLowerCase()];
    
    if (!languageId) {
      throw new Error(`Unsupported language: ${language}`);
    }

    if (!process.env.RAPIDAPI_KEY) {
      logger.warn('RAPIDAPI_KEY not configured, using fallback execution service');
      return await fallbackExecution({ code, language, input, testCases });
    }

    // Single execution if no test cases
    if (testCases.length === 0) {
      return await executeSingleRun({
        code,
        languageId,
        input
      });
    }

    // Batch execution for test cases
    return await executeBatchTestCases({
      code,
      languageId,
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
      testResults: []
    };
  }
}

/**
 * Execute a single code run
 */
async function executeSingleRun({ code, languageId, input }) {
  const submission = {
    source_code: Buffer.from(code).toString('base64'),
    language_id: languageId,
    stdin: Buffer.from(input).toString('base64'),
    cpu_time_limit: EXECUTION_CONFIG.maxCpuTime,
    memory_limit: EXECUTION_CONFIG.maxMemory,
    wall_time_limit: EXECUTION_CONFIG.maxCpuTime + 2,
    enable_per_process_and_thread_time_limit: true,
    enable_per_process_and_thread_memory_limit: true
  };

  // Submit code for execution
  const submitResponse = await axios.post(
    `${process.env.JUDGE0_API_URL}/submissions`,
    submission,
    {
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com',
        'Content-Type': 'application/json'
      },
      timeout: EXECUTION_CONFIG.timeout
    }
  );

  const token = submitResponse.data.token;
  
  // Poll for results
  const result = await pollForResult(token);
  
  return {
    success: result.status.id <= 3, // 1=In Queue, 2=Processing, 3=Accepted
    output: result.stdout ? Buffer.from(result.stdout, 'base64').toString() : '',
    error: result.stderr ? Buffer.from(result.stderr, 'base64').toString() : result.compile_output ? Buffer.from(result.compile_output, 'base64').toString() : '',
    executionTime: parseFloat(result.time) || 0,
    memoryUsage: parseInt(result.memory) || 0,
    status: result.status.description,
    statusId: result.status.id,
    testResults: []
  };
}

/**
 * Execute code against multiple test cases
 */
async function executeBatchTestCases({ code, languageId, testCases }) {
  const submissions = testCases.map((testCase, index) => ({
    source_code: Buffer.from(code).toString('base64'),
    language_id: languageId,
    stdin: Buffer.from(testCase.input || '').toString('base64'),
    expected_output: Buffer.from(testCase.expectedOutput || '').toString('base64'),
    cpu_time_limit: EXECUTION_CONFIG.maxCpuTime,
    memory_limit: EXECUTION_CONFIG.maxMemory,
    wall_time_limit: EXECUTION_CONFIG.maxCpuTime + 2,
    enable_per_process_and_thread_time_limit: true,
    enable_per_process_and_thread_memory_limit: true
  }));

  try {
    // Submit batch of test cases
    const batchResponse = await axios.post(
      `${process.env.JUDGE0_API_URL}/submissions/batch`,
      { submissions },
      {
        headers: {
          'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com',
          'Content-Type': 'application/json'
        },
        timeout: EXECUTION_CONFIG.timeout
      }
    );

    const tokens = batchResponse.data.map(result => result.token);
    
    // Poll for all results
    const results = await Promise.all(
      tokens.map(token => pollForResult(token))
    );

    // Process test results
    const testResults = results.map((result, index) => {
      const actualOutput = result.stdout ? Buffer.from(result.stdout, 'base64').toString().trim() : '';
      const expectedOutput = testCases[index].expectedOutput?.trim() || '';
      const passed = actualOutput === expectedOutput && result.status.id === 3;

      return {
        testCaseIndex: index,
        passed,
        input: testCases[index].input || '',
        expectedOutput,
        actualOutput,
        error: result.stderr ? Buffer.from(result.stderr, 'base64').toString() : '',
        executionTime: parseFloat(result.time) || 0,
        memoryUsage: parseInt(result.memory) || 0,
        status: result.status.description
      };
    });

    const passedTests = testResults.filter(t => t.passed).length;
    const totalTests = testResults.length;
    const score = totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 0;

    return {
      success: passedTests > 0,
      output: results[0]?.stdout ? Buffer.from(results[0].stdout, 'base64').toString() : '',
      error: results[0]?.stderr ? Buffer.from(results[0].stderr, 'base64').toString() : '',
      executionTime: Math.max(...results.map(r => parseFloat(r.time) || 0)),
      memoryUsage: Math.max(...results.map(r => parseInt(r.memory) || 0)),
      testResults,
      score,
      passedTests,
      totalTests
    };

  } catch (error) {
    logger.error('Batch execution failed:', error);
    throw error;
  }
}

/**
 * Poll for execution result
 */
async function pollForResult(token, attempt = 0) {
  if (attempt >= EXECUTION_CONFIG.maxPollAttempts) {
    throw new Error('Execution timeout: Maximum poll attempts reached');
  }

  try {
    const response = await axios.get(
      `${process.env.JUDGE0_API_URL}/submissions/${token}`,
      {
        headers: {
          'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com'
        },
        timeout: EXECUTION_CONFIG.timeout
      }
    );

    const result = response.data;
    
    // Status 1 = In Queue, 2 = Processing
    if (result.status.id <= 2) {
      await new Promise(resolve => setTimeout(resolve, EXECUTION_CONFIG.pollInterval));
      return await pollForResult(token, attempt + 1);
    }

    return result;
    
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      throw new Error('Execution timeout: Request timed out');
    }
    throw error;
  }
}

/**
 * Fallback execution service for development/testing
 */
async function fallbackExecution({ code, language, input, testCases }) {
  logger.info('Using fallback execution service (development mode)');
  
  // Simulate execution delay
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Mock execution results
  const mockResults = {
    success: true,
    output: `Mock execution result for ${language}\nCode length: ${code.length} characters\nInput: ${input || 'none'}`,
    error: '',
    executionTime: Math.random() * 100,
    memoryUsage: Math.floor(Math.random() * 10000),
    testResults: []
  };

  // Mock test case results if provided
  if (testCases.length > 0) {
    mockResults.testResults = testCases.map((testCase, index) => ({
      testCaseIndex: index,
      passed: Math.random() > 0.3, // 70% pass rate
      input: testCase.input || '',
      expectedOutput: testCase.expectedOutput || '',
      actualOutput: testCase.expectedOutput || 'mock output',
      error: Math.random() > 0.8 ? 'Mock runtime error' : '',
      executionTime: Math.random() * 50,
      memoryUsage: Math.floor(Math.random() * 5000),
      status: 'Accepted'
    }));
    
    const passedTests = mockResults.testResults.filter(t => t.passed).length;
    mockResults.passedTests = passedTests;
    mockResults.totalTests = testCases.length;
    mockResults.score = Math.round((passedTests / testCases.length) * 100);
  }
  
  return mockResults;
}

/**
 * Get supported languages
 */
export function getSupportedLanguages() {
  return Object.keys(LANGUAGE_IDS).map(lang => ({
    name: lang,
    id: LANGUAGE_IDS[lang],
    displayName: lang.charAt(0).toUpperCase() + lang.slice(1)
  }));
}

/**
 * Validate code before execution
 */
export function validateCode(code, language) {
  const errors = [];
  
  if (!code || code.trim().length === 0) {
    errors.push('Code cannot be empty');
  }
  
  if (code.length > 65000) {
    errors.push('Code is too long (maximum 65KB)');
  }
  
  if (!LANGUAGE_IDS[language.toLowerCase()]) {
    errors.push(`Unsupported language: ${language}`);
  }
  
  // Language-specific validation
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
  LANGUAGE_IDS
};