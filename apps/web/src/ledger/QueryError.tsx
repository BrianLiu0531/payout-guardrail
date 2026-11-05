import { ApiError } from '../api.js';

export function QueryError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const message = error instanceof ApiError ? `${error.message} (${error.code})` : 'Could not reach the API.';
  return (
    <div className="error-box" role="alert">
      <span>{message}</span>
      <button type="button" className="button-secondary" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
