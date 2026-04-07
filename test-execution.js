/**
 * Direct execution test to debug output pipeline
 */

import axios from 'axios';
import { executeCode, validateCode } from './src/services/codeExecution.js';

const testCode = {
  python: 'print("Hello from Python!")\nprint("This is a test")',
  javascript: 'console.log("Hello from JavaScript!");\nconsole.log("Testing execution");',
  java: 'public class Main { public static void main(String[] args) { System.out.println("Hello from Java!"); } }'
};

async function testExecution() {
  console.log('🧪 Starting execution pipeline test...\n');

  for (const [lang, code] of Object.entries(testCode)) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing ${lang.toUpperCase()}`);
    console.log('='.repeat(60));

    try {
      // Test 1: Validation
      console.log('\n1️⃣ Testing code validation...');
      const validation = validateCode(code, lang);
      console.log(`   Valid: ${validation.isValid}`);
      if (validation.errors.length > 0) {
        console.log(`   Errors:`, validation.errors);
      }

      // Test 2: Execution
      console.log('\n2️⃣ Executing code...');
      const result = await executeCode({
        code,
        language: lang,
        input: '',
        testCases: []
      });

      console.log(`   Success: ${result.success}`);
      console.log(`   Provider: ${result.provider}`);
      console.log(`   Status: ${result.status}`);
      console.log(`   Execution Time: ${result.executionTime}ms`);
      console.log(`   Memory Usage: ${result.memoryUsage} bytes`);
      
      console.log('\n   Output:');
      if (result.output) {
        console.log(`   "${result.output}"`);
      } else {
        console.log('   ⚠️  NO OUTPUT RECEIVED');
      }

      if (result.error) {
        console.log('\n   Error:');
        console.log(`   "${result.error}"`);
      }

      // Test 3: Response format check
      console.log('\n3️⃣ Response format check:');
      console.log(`   Has output property: ${typeof result.output !== 'undefined'}`);
      console.log(`   Output type: ${typeof result.output}`);
      console.log(`   Output length: ${(result.output || '').length} chars`);
      console.log(`   All expected fields present:`, {
        success: 'success' in result,
        output: 'output' in result,
        error: 'error' in result,
        executionTime: 'executionTime' in result,
        memoryUsage: 'memoryUsage' in result,
        status: 'status' in result,
        provider: 'provider' in result,
        testResults: 'testResults' in result
      });

    } catch (error) {
      console.error(`❌ Test failed for ${lang}:`, error.message);
      console.error(error.stack);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('✅ Test complete');
}

testExecution().catch(console.error);
