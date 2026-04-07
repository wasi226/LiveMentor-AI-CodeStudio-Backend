#!/usr/bin/env node

/**
 * Direct HTTP API test
 * Test the /api/code/execute endpoint
 */

import fetch from 'node-fetch';

const API_URL = 'http://localhost:3001/api/code/execute';

// Mock token (use a valid one from your system)
const mockToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InRlc3RAeWFobm8uY29tIiwicm9sZSI6InN0dWRlbnQiLCJpYXQiOjE3NDU4NzU1OTcsImV4cCI6MTc0NTk2MTk5N30.test_token_signature';

async function testAPIExecution() {
  console.log('🌐 Testing /api/code/execute endpoint...\n');

  const testCases = [
    {
      name: 'Simple JavaScript',
      code: 'console.log("Hello");\nconsole.log("World");',
      language: 'javascript'
    },
    {
      name: 'Simple Python',
      code: 'print("Hello")\nprint("Python")',
      language: 'python'
    }
  ];

  for (const test of testCases) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Test: ${test.name}`);
    console.log('='.repeat(60));

    try {
      console.log('\n📤 Sending request to', API_URL);
      console.log('   Code:', JSON.stringify(test.code).substring(0, 50) + '...');
      console.log('   Language:', test.language);

      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${mockToken}`
        },
        body: JSON.stringify({
          code: test.code,
          language: test.language,
          input: '',
          testCases: []
        })
      });

      console.log('\n📥 Response received');
      console.log('   Status:', response.status);
      console.log('   Status Text:', response.statusText);

      const contentType = response.headers.get('content-type');
      console.log('   Content-Type:', contentType);

      const text = await response.text();
      console.log('   Response Size:', text.length, 'bytes');

      let data;
      try {
        data = JSON.parse(text);
      } catch (parseError) {
        console.error('   ❌ Failed to parse JSON response:');
        console.error('   ', parseError.message);
        console.error('   Raw response:', text.substring(0, 200));
        continue;
      }

      console.log('\n📊 Parsed Response:');
      console.log('   success:', data.success);
      console.log('   output:', data.output ? `${data.output.substring(0, 50)}...` : 'EMPTY/MISSING');
      console.log('   error:', data.error || 'none');
      console.log('   status:', data.status);
      console.log('   provider:', data.provider);
      console.log('   executionTime:', data.executionTime, 'ms');
      console.log('   memoryUsage:', data.memoryUsage, 'bytes');

      // Check response structure
      console.log('\n✅ Response Structure Check:');
      const hasRequiredFields = {
        success: 'success' in data,
        output: 'output' in data,
        error: 'error' in data,
        executionTime: 'executionTime' in data,
        memoryUsage: 'memoryUsage' in data,
        language: 'language' in data,
        timestamp: 'timestamp' in data
      };

      Object.entries(hasRequiredFields).forEach(([field, hasIt]) => {
        console.log(`   ${hasIt ? '✓' : '✗'} ${field}`);
      });

    } catch (error) {
      console.error('❌ Test failed:', error.message);
      if (error.code === 'ECONNREFUSED') {
        console.error('   Backend server is not running on port 3001');
      }
    }
  }
}

testAPIExecution().catch(console.error);
