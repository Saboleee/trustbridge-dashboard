/**
 * Error handling utilities for React components.
 * Provides error boundary support and error recovery strategies.
 *
 * Also defines the shared API error JSON shape used across `src/app/api/`
 * route handlers so clients can rely on a single documented envelope:
 *
 *   { "error": { "code": string, "message": string, "details"?: unknown, "correlationId"?: string } }
 *
 * See `docs/error-taxonomy.md` for the full taxonomy.
 */

export interface ErrorInfo {
  componentStack: string;
  errorMessage: string;
  errorStack?: string;
  timestamp: Date;
}

export interface ErrorBoundaryConfig {
  /**
   * Enable error logging to external service
   */
  enableLogging?: boolean;
  /**
   * Callback when error is caught
   */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /**
   * Whether to show fallback UI
   */
  showFallback?: boolean;
  /**
   * Custom error fallback component
   */
  fallbackComponent?: React.ComponentType<{ error: Error; reset: () => void }>;
}

/**
 * Error logger for tracking component errors.
 */
export class ErrorLogger {
  private errors: ErrorInfo[] = [];
  private readonly maxErrors: number;

  constructor(maxErrors: number = 100) {
    this.maxErrors = maxErrors;
  }

  /**
   * Log an error with component context.
   */
  log(error: Error, componentStack: string): ErrorInfo {
    const errorInfo: ErrorInfo = {
      errorMessage: error.message,
      componentStack,
      errorStack: error.stack,
      timestamp: new Date(),
    };

    this.errors.push(errorInfo);

    // Keep only recent errors
    if (this.errors.length > this.maxErrors) {
      this.errors = this.errors.slice(-this.maxErrors);
    }

    return errorInfo;
  }

  /**
   * Get all logged errors.
   */
  getErrors(): ErrorInfo[] {
    return [...this.errors];
  }

  /**
   * Get errors for a specific time range.
   */
  getErrorsSince(minutesAgo: number): ErrorInfo[] {
    const cutoff = Date.now() - minutesAgo * 60 * 1000;
    return this.errors.filter((e) => e.timestamp.getTime() > cutoff);
  }

  /**
   * Get error statistics.
   */
  getStats(): {
    total: number;
    recentErrors: number;
    lastError?: ErrorInfo;
  } {
    return {
      total: this.errors.length,
      recentErrors: this.getErrorsSince(5).length,
      lastError: this.errors[this.errors.length - 1],
    };
  }

  /**
   * Clear all logged errors.
   */
  clear(): void {
    this.errors = [];
  }

  /**
   * Export errors as JSON for debugging.
   */
  toJSON(): string {
    return JSON.stringify(this.errors, null, 2);
  }
}

/**
 * Global error logger instance.
 */
export const globalErrorLogger = new ErrorLogger();

/**
 * User-friendly error messages.
 */
export const errorMessages: Record<string, string> = {
  NETWORK_ERROR: 'Network error. Please check your connection and try again.',
  TIMEOUT_ERROR: 'Request timed out. Please try again.',
  SERVER_ERROR: 'Server error. Please try again later.',
  UNAUTHORIZED: 'You do not have permission to perform this action.',
  NOT_FOUND: 'The requested resource was not found.',
  VALIDATION_ERROR: 'Please check your input and try again.',
  UNKNOWN_ERROR: 'An unexpected error occurred. Please try again.',
};

/**
 * Map error codes to user-friendly messages.
 */
export function getUserFriendlyMessage(errorCode: string): string {
  return errorMessages[errorCode] || errorMessages.UNKNOWN_ERROR;
}

/**
 * Canonical API error codes shared across route handlers and clients.
 * Keep in sync with `docs/error-taxonomy.md`.
 */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'UNKNOWN_ERROR';

/**
 * Shared API error JSON shape emitted by every route handler.
 *
 * `correlationId` is the audit correlation id (see `src/lib/audit.ts`) that
 * support can quote to trace a maintainer mutation. It is optional so
 * non-mutating handlers and legacy clients remain compatible.
 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
    correlationId?: string;
  };
}

/**
 * Default HTTP status for each API error code.
 */
export const apiErrorStatus: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  UNKNOWN_ERROR: 500,
};

/**
 * Build the shared API error body. Falls back to a stable user-friendly
 * message when none is provided so clients always have something to toast.
 *
 * Pass `correlationId` (from `src/lib/audit.ts`) on maintainer mutation
 * failures so support can trace the request.
 */
export function createApiError(
  code: ApiErrorCode,
  message?: string,
  details?: unknown,
  correlationId?: string
): ApiErrorBody {
  const body: ApiErrorBody = {
    error: {
      code,
      message: message || getUserFriendlyMessage(code),
    },
  };

  if (details !== undefined) {
    body.error.details = details;
  }

  if (correlationId) {
    body.error.correlationId = correlationId;
  }

  return body;
}

/**
 * Build a JSON `Response` with the shared error envelope and matching status.
 * Route handlers should return this instead of ad-hoc `{ error: string }`.
 *
 * When `correlationId` is provided it is echoed both in the JSON body and in
 * the `X-Correlation-Id` response header so operators can trace the request
 * even when the body is not surfaced to the user.
 */
export function apiErrorResponse(
  code: ApiErrorCode,
  message?: string,
  details?: unknown,
  status?: number,
  correlationId?: string
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (correlationId) {
    headers['X-Correlation-Id'] = correlationId;
  }

  return new Response(
    JSON.stringify(createApiError(code, message, details, correlationId)),
    {
      status: status ?? apiErrorStatus[code],
      headers,
    }
  );
}

/**
 * Match actual HTTP 5xx server status codes, or explicit server-error enums,
 * without misclassifying unrelated numeric fragments like "field 5".
 */
function hasServerFailureStatus(message: string): boolean {
  if (/(?:^|[^0-9])5\d{2}(?!\d)(?=$|[^0-9])/i.test(message)) {
    return true;
  }

  return /(?:^|[^A-Z_])(?:INTERNAL_SERVER_ERROR|BAD_GATEWAY|SERVICE_UNAVAILABLE|GATEWAY_TIMEOUT|HTTP_5XX|5XX)(?=$|[^A-Z_])/i.test(
    message
  );
}

/**
 * Classify errors by type for handling.
 */
export function classifyError(error: unknown): {
  type: 'network' | 'validation' | 'auth' | 'server' | 'unknown';
  message: string;
  recoverable: boolean;
} {
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return {
      type: 'network',
      message: getUserFriendlyMessage('NETWORK_ERROR'),
      recoverable: true,
    };
  }

  if (error instanceof Error) {
    if (error.message.includes('timeout')) {
      return {
        type: 'network',
        message: getUserFriendlyMessage('TIMEOUT_ERROR'),
        recoverable: true,
      };
    }

    if (error.message.includes('401') || error.message.includes('403')) {
      return {
        type: 'auth',
        message: getUserFriendlyMessage('UNAUTHORIZED'),
        recoverable: false,
      };
    }

    if (hasServerFailureStatus(error.message)) {
      return {
        type: 'server',
        message: getUserFriendlyMessage('SERVER_ERROR'),
        recoverable: true,
      };
    }
  }

  return {
    type: 'unknown',
    message: getUserFriendlyMessage('UNKNOWN_ERROR'),
    recoverable: true,
  };
}
