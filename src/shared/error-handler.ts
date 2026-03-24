// ============================================================================
// Salesforce error classification — shared utility
// ============================================================================

import { SalesforceErrorType, type ClassifiedError } from '../types/index.js';

export { SalesforceErrorType };

export function classifySalesforceError(error: unknown): ClassifiedError {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorCode = (error as any)?.errorCode || (error as any)?.name || '';

  if (
    errorCode === 'INVALID_SESSION_ID' ||
    errorMessage.includes('INVALID_SESSION_ID') ||
    errorMessage.includes('Session expired') ||
    errorMessage.includes('Invalid Session ID') ||
    errorMessage.includes('userinfo request failed (HTTP 401)') ||
    errorMessage.includes('userinfo request failed (HTTP 403)') ||
    errorMessage.includes('All candidates returned 401/403/3xx')
  ) {
    return { type: SalesforceErrorType.INVALID_SESSION, message: errorMessage, originalError: error, statusCode: errorCode, isRetryable: false, userMessage: 'Your Salesforce session has expired or the access token is invalid. Please re-authenticate.' };
  }

  if (
    errorCode === 'INSUFFICIENT_ACCESS' ||
    errorCode === 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' ||
    errorCode === 'INSUFFICIENT_ACCESS_OR_READONLY' ||
    errorMessage.includes('INSUFFICIENT_ACCESS') ||
    errorMessage.includes('insufficient access rights')
  ) {
    return { type: SalesforceErrorType.INSUFFICIENT_ACCESS, message: errorMessage, originalError: error, statusCode: errorCode, isRetryable: false, userMessage: 'You do not have sufficient permissions to perform this operation.' };
  }

  if (errorCode === 'INVALID_FIELD' || errorMessage.includes('INVALID_FIELD') || errorMessage.includes('No such column')) {
    return { type: SalesforceErrorType.INVALID_FIELD, message: errorMessage, originalError: error, statusCode: errorCode, isRetryable: false, userMessage: 'The specified field does not exist or is not accessible.' };
  }

  if (errorCode === 'QUERY_TIMEOUT' || errorMessage.includes('QUERY_TIMEOUT') || errorMessage.includes('query timeout')) {
    return { type: SalesforceErrorType.QUERY_TIMEOUT, message: errorMessage, originalError: error, statusCode: errorCode, isRetryable: true, userMessage: 'The query took too long. Try reducing the scope.' };
  }

  if (errorCode === 'REQUEST_LIMIT_EXCEEDED' || errorCode === 'API_CURRENTLY_DISABLED' || errorMessage.includes('REQUEST_LIMIT_EXCEEDED')) {
    return { type: SalesforceErrorType.API_LIMIT_EXCEEDED, message: errorMessage, originalError: error, statusCode: errorCode, isRetryable: true, userMessage: 'Salesforce API limits exceeded. Try again later.' };
  }

  if (errorCode === 'INVALID_TYPE' || errorCode === 'INVALID_OPERATION' || errorMessage.includes('INVALID_TYPE')) {
    return { type: SalesforceErrorType.INVALID_OPERATION, message: errorMessage, originalError: error, statusCode: errorCode, isRetryable: false, userMessage: 'The operation is not valid for this object or field type.' };
  }

  return { type: SalesforceErrorType.UNKNOWN, message: errorMessage, originalError: error, statusCode: errorCode, isRetryable: false, userMessage: `An error occurred: ${errorMessage}` };
}

export function formatClassifiedError(classified: ClassifiedError): string {
  let formatted = `[${classified.type}] ${classified.userMessage}`;
  if (classified.statusCode) formatted += ` (Error Code: ${classified.statusCode})`;
  if (classified.isRetryable) formatted += '\n\nThis error may be temporary. Please try again.';
  return formatted;
}
