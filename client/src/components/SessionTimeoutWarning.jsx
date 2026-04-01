import { useState, useEffect, useCallback } from "react";

const WARNING_THRESHOLD_MS = 5 * 60 * 1000; // Show warning at 5 min remaining
const SESSION_DURATION_MS = 30 * 60 * 1000; // 30 min total

export default function SessionTimeoutWarning({ lastActivity, onExpired }) {
  const [showWarning, setShowWarning] = useState(false);
  const [remaining, setRemaining] = useState(null);
  const [expired, setExpired] = useState(false);

  const checkTimeout = useCallback(() => {
    if (!lastActivity) return;
    const elapsed = Date.now() - lastActivity;
    const left = SESSION_DURATION_MS - elapsed;

    if (left <= 0) {
      setExpired(true);
      setShowWarning(false);
      if (onExpired) onExpired();
    } else if (left <= WARNING_THRESHOLD_MS) {
      setShowWarning(true);
      setRemaining(Math.ceil(left / 1000));
    } else {
      setShowWarning(false);
      setRemaining(null);
    }
  }, [lastActivity, onExpired]);

  useEffect(() => {
    const interval = setInterval(checkTimeout, 1000);
    checkTimeout();
    return () => clearInterval(interval);
  }, [checkTimeout]);

  if (expired) {
    return (
      <div
        className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
        role="alertdialog"
        aria-modal="true"
        aria-label="Session expired"
      >
        <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6 text-center space-y-4">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto" aria-hidden="true">
            <span className="text-red-600 text-3xl">!</span>
          </div>
          <h2 className="text-xl font-bold text-gray-800">Session Expired</h2>
          <p className="text-gray-600 text-sm">
            Your session has timed out due to inactivity. Please start a new intake.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="w-full bg-cushion-600 text-white rounded-lg py-3 font-medium hover:bg-cushion-700 transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500 focus:ring-offset-2"
          >
            Start New Intake
          </button>
        </div>
      </div>
    );
  }

  if (!showWarning || remaining === null) return null;

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  return (
    <div
      className="fixed top-0 left-0 right-0 bg-yellow-500 text-yellow-900 text-center py-2 px-4 text-sm font-medium z-50"
      role="alert"
      aria-live="assertive"
    >
      Session expires in {minutes}:{seconds.toString().padStart(2, "0")} — please finish or send a message to stay active.
    </div>
  );
}
