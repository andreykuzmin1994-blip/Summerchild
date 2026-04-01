export default function ErrorBanner({ message, onRetry }) {
  if (!message) return null;

  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4" role="alert" aria-live="polite">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-red-800 text-sm font-medium">Something went wrong</p>
          <p className="text-red-600 text-sm mt-1">{message}</p>
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="ml-4 text-sm text-red-700 border border-red-300 rounded px-3 py-1 hover:bg-red-100 transition-colors flex-shrink-0"
            aria-label="Retry failed operation"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
