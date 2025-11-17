/**
 * Example: Using HTTP Header-Based Authentication with Streamable HTTP Transport
 * 
 * This example demonstrates how to authenticate with the Salesforce MCP server
 * using custom HTTP headers instead of body parameters.
 * 
 * Prerequisites:
 * 1. Start the MCP server with HTTP transport:
 *    MCP_TRANSPORT_TYPE=streamable-http node dist/index.js
 * 
 * 2. Obtain OAuth credentials from your Salesforce org
 */

const http = require('http');

// Configuration
const MCP_SERVER_URL = 'http://localhost:3000';
const SALESFORCE_CREDENTIALS = {
  accessToken: 'YOUR_ACCESS_TOKEN',
  instanceUrl: 'https://your-instance.salesforce.com',
  username: 'your.email@example.com',
  userId: 'YOUR_USER_ID'
};

/**
 * Make an MCP tool call with header-based authentication
 */
function callMCPTool(toolName, toolArguments) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: toolArguments
      }
    });

    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        // Salesforce authentication headers
        'x-salesforce-access-token': SALESFORCE_CREDENTIALS.accessToken,
        'x-salesforce-instance-url': SALESFORCE_CREDENTIALS.instanceUrl,
        'x-salesforce-username': SALESFORCE_CREDENTIALS.username,
        'x-salesforce-user-id': SALESFORCE_CREDENTIALS.userId
      }
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve(response);
        } catch (error) {
          reject(new Error(`Failed to parse response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Example 1: Query Accounts
 */
async function queryAccounts() {
  console.log('\n=== Example 1: Query Accounts ===');
  
  try {
    const response = await callMCPTool('salesforce_query_records', {
      objectName: 'Account',
      fields: ['Id', 'Name', 'Industry', 'AnnualRevenue'],
      whereClause: 'Industry != null',
      limit: 5
    });
    
    console.log('Success!');
    console.log(JSON.stringify(response, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

/**
 * Example 2: Search Objects
 */
async function searchObjects() {
  console.log('\n=== Example 2: Search Objects ===');
  
  try {
    const response = await callMCPTool('salesforce_search_objects', {
      searchPattern: 'Account'
    });
    
    console.log('Success!');
    console.log(JSON.stringify(response, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

/**
 * Example 3: Describe Object
 */
async function describeObject() {
  console.log('\n=== Example 3: Describe Object ===');
  
  try {
    const response = await callMCPTool('salesforce_describe_object', {
      objectName: 'Contact'
    });
    
    console.log('Success!');
    // Only show first 500 chars to avoid overwhelming output
    const responseStr = JSON.stringify(response, null, 2);
    console.log(responseStr.substring(0, 500) + '...');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

/**
 * Example 4: Aggregate Query
 */
async function aggregateQuery() {
  console.log('\n=== Example 4: Aggregate Query ===');
  
  try {
    const response = await callMCPTool('salesforce_aggregate_query', {
      objectName: 'Opportunity',
      selectFields: ['StageName', 'COUNT(Id) OpportunityCount', 'SUM(Amount) TotalRevenue'],
      groupByFields: ['StageName']
    });
    
    console.log('Success!');
    console.log(JSON.stringify(response, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('Salesforce MCP Server - HTTP Header Authentication Examples');
  console.log('============================================================');
  
  // Check if credentials are configured
  if (SALESFORCE_CREDENTIALS.accessToken === 'YOUR_ACCESS_TOKEN') {
    console.error('\n❌ Error: Please configure your Salesforce credentials first!');
    console.log('\nEdit this file and set:');
    console.log('  - accessToken');
    console.log('  - instanceUrl');
    console.log('  - username');
    console.log('  - userId');
    return;
  }
  
  try {
    await queryAccounts();
    await searchObjects();
    await describeObject();
    await aggregateQuery();
    
    console.log('\n✅ All examples completed successfully!');
  } catch (error) {
    console.error('\n❌ Error:', error.message);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { callMCPTool };
