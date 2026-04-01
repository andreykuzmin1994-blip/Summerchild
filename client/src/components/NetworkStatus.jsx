import { useState, useEffect } from "react";

export default function NetworkStatus() {
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setOffline(false);
    const handleOffline = () => setOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      className="fixed inset-0 bg-white z-50 flex items-center justify-center p-6"
      role="alert"
      aria-live="assertive"
    >
      <div className="max-w-md text-center space-y-4">
        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto" aria-hidden="true">
          <span className="text-red-600 text-3xl">!</span>
        </div>
        <h1 className="text-xl font-bold text-gray-800">Connection Lost</h1>
        <p className="text-gray-600">
          This device has lost its network connection.
          Please see a staff member for assistance.
        </p>
        <p className="text-sm text-gray-400">
          Your progress has been saved. The session will resume when the connection is restored.
        </p>
      </div>
    </div>
  );
}
