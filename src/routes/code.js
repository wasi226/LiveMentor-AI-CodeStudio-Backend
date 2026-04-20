/**
 * Code Execution Routes
 * Handles secure code execution and validation endpoints
 */

import express from 'express';
import { executeCode, getSupportedLanguages, validateCode } from '../services/codeExecution.js';
import { validateBody, codeSchemas } from '../middleware/validation.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * @route POST /api/code/execute
 * @desc Execute code securely using Piston API
 * @access Authenticated users (students, faculty)
 * @body {
 *   code: string,
 *   language: string,
 *   input?: string,
 *   testCases?: Array<{input: string, expectedOutput: string}>
 * }
 */
router.post('/execute', validateBody(codeSchemas.execute), async (req, res) => {
  try {
    const { code, language, input, testCases } = req.body;
    const userEmail = req.user.email;

    logger.info(`Code execution request from ${userEmail} for ${language}`);
    console.log('[DEBUG] Code to execute:', code.substring(0, 100) + (code.length > 100 ? '...' : ''));
    console.log('[DEBUG] Language:', language);
    console.log('[DEBUG] Input:', input);
    console.log('[DEBUG] Test cases:', testCases?.length || 0);

    // Validate code before execution
    const validation = validateCode(code, language);
    if (!validation.isValid) {
      console.log('[DEBUG] Validation failed:', validation.errors);
      return res.status(400).json({
        error: 'Code Validation Failed',
        message: 'The provided code contains errors or security violations',
        details: validation.errors
      });
    }

    // Execute code
    const startTime = Date.now();
    console.log('[DEBUG] Starting code execution...');
    const result = await Promise.resolve(executeCode({
      code,
      language,
      input: input || '',
      testCases: testCases || []
    }));
    const executionDuration = Date.now() - startTime;
    console.log('[DEBUG] Execution completed in', executionDuration, 'ms');
    console.log('[DEBUG] Result:', {
      success: result.success,
      outputLength: result.output?.length || 0,
      errorLength: result.error?.length || 0,
      provider: result.provider,
      status: result.status
    });

    // Log execution results for monitoring
    logger.info(`Code execution completed for ${userEmail}: ${result.success ? 'success' : 'failed'} in ${executionDuration}ms`);

    // Return structured response
    const responseData = {
      success: result.success,
      output: result.output,
      error: result.error,
      executionTime: result.executionTime,
      memoryUsage: result.memoryUsage,
      language,
      testResults: result.testResults || [],
      score: result.score || null,
      passedTests: result.passedTests || null,
      totalTests: result.totalTests || null,
      status: result.status || 'completed',
      timestamp: new Date().toISOString(),
      metadata: {
        userId: userEmail,
        serverExecutionTime: executionDuration,
        codeLength: code.length,
        hasTestCases: (testCases || []).length > 0
      }
    };
    
    console.log('[DEBUG] Sending response:', {
      success: responseData.success,
      outputLength: responseData.output?.length || 0,
      errorLength: responseData.error?.length || 0,
      status: responseData.status,
      timestamp: responseData.timestamp
    });
    
    res.json(responseData);

  } catch (error) {
    logger.error('Code execution error:', error);
    res.status(500).json({
      success: false,
      error: 'Execution Failed',
      message: 'An error occurred during code execution',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

router.all('/execute', (req, res) => {
  logger.warn(`Method not allowed on /api/code/execute: ${req.method}`);
  res.set('Allow', 'POST');
  return res.status(405).json({
    success: false,
    error: 'Method Not Allowed',
    message: 'Use POST /api/code/execute with JSON body.',
    allowedMethods: ['POST']
  });
});

/**
 * @route POST /api/code/validate
 * @desc Validate code syntax and security
 * @access Authenticated users
 * @body { code: string, language: string }
 */
router.post('/validate', async (req, res) => {
  try {
    const { code, language } = req.body;

    if (!code || !language) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Code and language are required'
      });
    }

    const validation = validateCode(code, language);

    res.json({
      isValid: validation.isValid,
      errors: validation.errors,
      language,
      codeLength: code.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Code validation error:', error);
    res.status(500).json({
      isValid: false,
      error: 'Validation Failed',
      message: 'An error occurred during code validation'
    });
  }
});

/**
 * @route GET /api/code/languages
 * @desc Get list of supported programming languages
 * @access Authenticated users
 */
router.get('/languages', (req, res) => {
  try {
    const languages = getSupportedLanguages();
    
    res.json({
      languages,
      total: languages.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Get languages error:', error);
    res.status(500).json({
      error: 'Server Error',
      message: 'Could not retrieve supported languages'
    });
  }
});

/**
 * @route POST /api/code/batch-execute
 * @desc Execute multiple code submissions in batch
 * @access Faculty and Admin only
 * @body {
 *   submissions: Array<{
 *     code: string,
 *     language: string,
 *     input?: string,
 *     testCases?: Array
 *   }>
 * }
 */
router.post('/batch-execute', async (req, res) => {
  try {
    const { submissions } = req.body;

    if (!Array.isArray(submissions) || submissions.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Submissions array is required and cannot be empty'
      });
    }

    if (submissions.length > 50) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Maximum 50 submissions allowed per batch'
      });
    }

    logger.info(`Batch execution request from ${req.user.email} for ${submissions.length} submissions`);

    // Execute all submissions
    const results = await Promise.allSettled(
      submissions.map(async (submission, index) => {
        try {
          const validation = validateCode(submission.code, submission.language);
          if (!validation.isValid) {
            return {
              index,
              success: false,
              error: 'Validation failed',
              details: validation.errors
            };
          }

          const result = await Promise.resolve(executeCode({
            code: submission.code,
            language: submission.language,
            input: submission.input || '',
            testCases: submission.testCases || []
          }));

          return {
            index,
            ...result
          };
        } catch (error) {
          return {
            index,
            success: false,
            error: error.message
          };
        }
      })
    );

    // Process results
    const processedResults = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          index,
          success: false,
          error: 'Execution failed',
          details: result.reason?.message || 'Unknown error'
        };
      }
    });

    const successCount = processedResults.filter(r => r.success).length;
    
    res.json({
      results: processedResults,
      summary: {
        total: submissions.length,
        successful: successCount,
        failed: submissions.length - successCount,
        successRate: Math.round((successCount / submissions.length) * 100)
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Batch execution error:', error);
    res.status(500).json({
      error: 'Batch Execution Failed',
      message: 'An error occurred during batch execution'
    });
  }
});

/**
 * @route GET /api/code/health
 * @desc Check code execution provider health status
 * @access Faculty and Admin only
 */
router.get('/health', async (req, res) => {
  try {
    // Test with simple code execution
    const testResult = await Promise.resolve(executeCode({
      code: 'console.log("Health check");',
      language: 'javascript',
      input: ''
    }));

    const isHealthy = testResult.success && !testResult.error && testResult.provider === 'piston';

    res.json({
      status: isHealthy ? 'healthy' : 'degraded',
      provider: testResult.provider || 'unknown',
      pistonConfigured: !!process.env.PISTON_API_URL,
      pistonAuthConfigured: !!process.env.PISTON_API_TOKEN,
      testExecution: {
        success: testResult.success,
        executionTime: testResult.executionTime,
        error: testResult.error
      },
      supportedLanguages: getSupportedLanguages().length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Code service health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;