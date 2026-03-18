interface ErrorResult {
    success: boolean;
    fullName?: string;
    errors?: Array<{ message: string; statusCode?: string; fields?: string | string[]; }> | 
            { message: string; statusCode?: string; fields?: string | string[]; };
  }
  
  export function formatMetadataError(result: ErrorResult | ErrorResult[], operation: string): string {
    let errorMessage = `Failed to ${operation}`;
    const saveResult = Array.isArray(result) ? result[0] : result;
    
    if (saveResult && saveResult.errors) {
      if (Array.isArray(saveResult.errors)) {
        errorMessage += ': ' + saveResult.errors.map((e: { message: string }) => e.message).join(', ');
      } else if (typeof saveResult.errors === 'object') {
        const error = saveResult.errors;
        errorMessage += `: ${error.message}`;
        if (error.fields) {
          errorMessage += ` (Field: ${error.fields})`;
        }
        if (error.statusCode) {
          errorMessage += ` [${error.statusCode}]`;
        }
      } else {
        errorMessage += ': ' + String(saveResult.errors);
      }
    }
  
    return errorMessage;
  }

/**
 * Salesforce error types for better error classification
 */
export enum SalesforceErrorType {
  INVALID_SESSION = 'INVALID_SESSION',
  INSUFFICIENT_ACCESS = 'INSUFFICIENT_ACCESS',
  INVALID_FIELD = 'INVALID_FIELD',
  INVALID_OPERATION = 'INVALID_OPERATION',
  QUERY_TIMEOUT = 'QUERY_TIMEOUT',
  API_LIMIT_EXCEEDED = 'API_LIMIT_EXCEEDED',
  UNKNOWN = 'UNKNOWN'
}

/**
 * Classified Salesforce error with additional context
 */
export interface ClassifiedError {
  type: SalesforceErrorType;
  message: string;
  originalError: Error;
  statusCode?: string;
  isRetryable: boolean;
  userMessage: string;
}

/**
 * Classify a Salesforce error based on error codes and messages
 */
export function classifySalesforceError(error: any): ClassifiedError {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorCode = error.errorCode || error.name || '';
  
  // Check for INVALID_SESSION_ID errors (expired/invalid token)
  // Also catches HTTP 401/403 from the userinfo endpoint (token issued by a
  // different authorization server, or revoked).
  if (
    errorCode === 'INVALID_SESSION_ID' ||
    errorMessage.includes('INVALID_SESSION_ID') ||
    errorMessage.includes('Session expired') ||
    errorMessage.includes('Invalid Session ID') ||
    errorMessage.includes('userinfo request failed (HTTP 401)') ||
    errorMessage.includes('userinfo request failed (HTTP 403)') ||
    errorMessage.includes('All candidates returned 401/403/3xx')
  ) {
    return {
      type: SalesforceErrorType.INVALID_SESSION,
      message: errorMessage,
      originalError: error,
      statusCode: errorCode,
      isRetryable: false,
      userMessage: 'Your Salesforce session has expired or the access token is invalid. Please re-authenticate.'
    };
  }
  
  // Check for INSUFFICIENT_ACCESS errors (permission denied)
  if (
    errorCode === 'INSUFFICIENT_ACCESS' ||
    errorCode === 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' ||
    errorCode === 'INSUFFICIENT_ACCESS_OR_READONLY' ||
    errorMessage.includes('INSUFFICIENT_ACCESS') ||
    errorMessage.includes('insufficient access rights')
  ) {
    return {
      type: SalesforceErrorType.INSUFFICIENT_ACCESS,
      message: errorMessage,
      originalError: error,
      statusCode: errorCode,
      isRetryable: false,
      userMessage: 'You do not have sufficient permissions to perform this operation. Please contact your Salesforce administrator.'
    };
  }
  
  // Check for INVALID_FIELD errors
  if (
    errorCode === 'INVALID_FIELD' ||
    errorMessage.includes('INVALID_FIELD') ||
    errorMessage.includes('No such column')
  ) {
    return {
      type: SalesforceErrorType.INVALID_FIELD,
      message: errorMessage,
      originalError: error,
      statusCode: errorCode,
      isRetryable: false,
      userMessage: 'The specified field does not exist or is not accessible.'
    };
  }
  
  // Check for QUERY_TIMEOUT errors
  if (
    errorCode === 'QUERY_TIMEOUT' ||
    errorMessage.includes('QUERY_TIMEOUT') ||
    errorMessage.includes('query timeout')
  ) {
    return {
      type: SalesforceErrorType.QUERY_TIMEOUT,
      message: errorMessage,
      originalError: error,
      statusCode: errorCode,
      isRetryable: true,
      userMessage: 'The query took too long to execute. Try reducing the scope of your query or adding filters.'
    };
  }
  
  // Check for API limit exceeded
  if (
    errorCode === 'REQUEST_LIMIT_EXCEEDED' ||
    errorCode === 'API_CURRENTLY_DISABLED' ||
    errorMessage.includes('API limit') ||
    errorMessage.includes('REQUEST_LIMIT_EXCEEDED')
  ) {
    return {
      type: SalesforceErrorType.API_LIMIT_EXCEEDED,
      message: errorMessage,
      originalError: error,
      statusCode: errorCode,
      isRetryable: true,
      userMessage: 'Salesforce API limits have been exceeded. Please try again later.'
    };
  }
  
  // Check for invalid operations
  if (
    errorCode === 'INVALID_TYPE' ||
    errorCode === 'INVALID_OPERATION' ||
    errorMessage.includes('INVALID_TYPE')
  ) {
    return {
      type: SalesforceErrorType.INVALID_OPERATION,
      message: errorMessage,
      originalError: error,
      statusCode: errorCode,
      isRetryable: false,
      userMessage: 'The operation is not valid for this object or field type.'
    };
  }
  
  // Default to unknown error
  return {
    type: SalesforceErrorType.UNKNOWN,
    message: errorMessage,
    originalError: error,
    statusCode: errorCode,
    isRetryable: false,
    userMessage: `An error occurred: ${errorMessage}`
  };
}

/**
 * Format a classified error for display to users
 */
export function formatClassifiedError(classified: ClassifiedError): string {
  let formatted = `[${classified.type}] ${classified.userMessage}`;
  
  if (classified.statusCode) {
    formatted += ` (Error Code: ${classified.statusCode})`;
  }
  
  if (classified.isRetryable) {
    formatted += '\n\nThis error may be temporary. Please try again.';
  }
  
  return formatted;
}