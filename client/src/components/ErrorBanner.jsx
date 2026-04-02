export default function ErrorBanner({ message, onRetry, rateLimitCountdown }) {
  if (!message) return null;

  const isRateLimit = rateLimitCountdown > 0;

  return (
    <div
      className={`${isRateLimit ? "bg-amber-50 border-amber-200" : "bg-red-50 border-red-200"} border rounded-lg p-4 mb-4`}
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start justify-between">
        <div>
          <p className={`${isRateLimit ? "text-amber-800" : "text-red-800"} text-sm font-medium`}>
            {isRateLimit ? "Please wait" : "Something went wrong"}
          </p>
          <p className={`${isRateLimit ? "text-amber-600" : "text-red-600"} text-sm mt-1`}>
            {message}
          </p>
          {isRateLimit && (
            <p className="text-amber-700 text-lg font-mono font-bold mt-2" aria-live="polite" aria-atomic="true">
              {rateLimitCountdown}s
            </p>
          )}
        </div>
        {onRetry && !isRateLimit && (
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
