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
      className="fixed top-0 left-0 right-0 bg-red-600 text-white text-center py-2 text-sm font-medium z-50"
      role="alert"
      aria-live="assertive"
    >
      You are offline. Please check your internet connection.
    </div>
  );
}
