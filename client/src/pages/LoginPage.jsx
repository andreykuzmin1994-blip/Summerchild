import { useState } from "react";
import { useNavigate } from "react-router-dom";
import SkipLink from "../components/SkipLink";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/caseworker/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Login failed");
        return;
      }

      // Token is now stored as httpOnly cookie (set by server) — not in localStorage
      localStorage.setItem("caseworker", JSON.stringify(data.caseworker));

      // Route based on role
      if (data.caseworker.role === "ADMIN") {
        navigate("/admin/dashboard");
      } else if (data.caseworker.role === "SUPERVISOR") {
        navigate("/supervisor/dashboard");
      } else {
        navigate("/caseworker/dashboard");
      }
    } catch {
      setError("Connection error. Please check your internet connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <SkipLink />
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <main id="main-content" className="max-w-sm w-full" role="main">
          <h1 className="text-2xl font-bold text-gray-800 text-center mb-2">Cushion Gov</h1>
          <p className="text-sm text-gray-500 text-center mb-8">Caseworker Portal</p>

          <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm border p-6 space-y-4" aria-label="Sign in form">
            {error && (
              <div id="loginError" className="bg-red-50 text-red-700 text-sm rounded-lg p-3" role="alert" aria-live="polite">{error}</div>
            )}
            <div>
              <label htmlFor="emailInput" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                id="emailInput"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cushion-500"
                required
                autoComplete="email"
                aria-describedby={error ? "loginError" : undefined}
              />
            </div>
            <div>
              <label htmlFor="passwordInput" className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input
                id="passwordInput"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cushion-500"
                required
                autoComplete="current-password"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-cushion-600 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-cushion-700 disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500 focus:ring-offset-2"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>
        </main>
      </div>
    </>
  );
}
