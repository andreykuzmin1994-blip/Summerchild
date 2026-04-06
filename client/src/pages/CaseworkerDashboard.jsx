import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import ErrorBanner from "../components/ErrorBanner";
import SkipLink from "../components/SkipLink";

const RISK_COLORS = {
  LOW: "bg-green-100 text-green-800",
  MEDIUM: "bg-yellow-100 text-yellow-800",
  HIGH: "bg-red-100 text-red-800",
};

export default function CaseworkerDashboard() {
  const [intakes, setIntakes] = useState([]);
  const [stats, setStats] = useState({});
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  const caseworker = JSON.parse(localStorage.getItem("caseworker") || "{}");

  useEffect(() => {
    if (!caseworker.id) {
      navigate("/login");
      return;
    }
    loadDashboard();
  }, [filter]);

  const loadDashboard = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filter) params.set("riskScore", filter);

      const res = await fetch(`/api/caseworker/dashboard?${params}`, {
        credentials: "include",
      });

      if (res.status === 401) {
        localStorage.removeItem("caseworker");
        navigate("/login");
        return;
      }

      if (!res.ok) throw new Error("Failed to load dashboard. Please try again.");

      const data = await res.json();
      setIntakes(data.intakes || []);
      setStats(data.stats || {});
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const handleLogout = () => {
    localStorage.removeItem("caseworker");
    localStorage.removeItem("caseworker");
    navigate("/login");
  };

  return (
    <>
      <SkipLink />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-gray-800">Cushion Gov</h1>
            <p className="text-xs text-gray-500">Caseworker Dashboard</p>
          </div>
          <nav className="flex items-center space-x-4" aria-label="User menu">
            <span className="text-sm text-gray-600 hidden sm:inline">{caseworker.name}</span>
            {(caseworker.role === "SUPERVISOR" || caseworker.role === "ADMIN") && (
              <Link to="/supervisor/dashboard" className="text-sm text-cushion-600 hover:text-cushion-800">
                Supervisor
              </Link>
            )}
            <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800" aria-label="Sign out">
              Sign Out
            </button>
          </nav>
        </header>

        <main id="main-content" className="max-w-6xl mx-auto p-4 sm:p-6" role="main">
          <ErrorBanner message={error} onRetry={loadDashboard} />

          {/* Stats */}
          <section className="grid grid-cols-2 sm:grid-cols-5 gap-3 sm:gap-4 mb-6" aria-label="Quick statistics">
            <StatCard label="Today" value={stats.intakesToday || 0} />
            <StatCard label="This Week" value={stats.intakesThisWeek || 0} />
            <StatCard label="Flagged" value={stats.flaggedIntakes || 0} color="text-red-600" />
            <StatCard label="Avg Time" value={stats.avgCompletionTimeMinutes ? `${stats.avgCompletionTimeMinutes}m` : "—"} />
            <StatCard label="Flag Rate" value={stats.flagRate || "0%"} />
          </section>

          {/* Filters */}
          <div className="flex items-center space-x-2 mb-4" role="group" aria-label="Filter by risk level">
            <span className="text-sm text-gray-500">Filter:</span>
            {["", "LOW", "MEDIUM", "HIGH"].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={`text-xs px-3 py-1 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500 ${
                  filter === f
                    ? "bg-cushion-600 text-white border-cushion-600"
                    : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                }`}
              >
                {f || "All"}
              </button>
            ))}
          </div>

          {/* Intake list */}
          {loading ? (
            <p className="text-gray-500 text-center py-8" role="status" aria-label="Loading intakes">Loading...</p>
          ) : intakes.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No intakes found</p>
          ) : (
            <nav aria-label="Intake queue">
              <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
                {intakes.map((intake) => (
                  <Link
                    key={intake.id}
                    to={`/caseworker/intake/${intake.id}`}
                    className="flex items-center justify-between px-3 sm:px-4 py-3 hover:bg-gray-50 transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cushion-500"
                    aria-label={`${intake.applicant ? `${intake.applicant.displayName}` : `Intake ${intake.id.slice(0, 8)}`}, ${intake.riskScore || "no"} risk${intake.expeditedFlag ? ", expedited" : ""}`}
                  >
                    <div className="flex items-center space-x-3 min-w-0">
                      {intake.expeditedFlag && (
                        <span className="bg-red-500 text-white text-xs px-2 py-0.5 rounded font-medium flex-shrink-0" aria-label="Expedited case">
                          EXPEDITED
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">
                          {intake.applicant
                            ? `${intake.applicant.displayName}`
                            : `Intake #${intake.id.slice(0, 8)}`}
                        </p>
                        <p className="text-xs text-gray-500">
                          {new Date(intake.createdAt).toLocaleString()} | HH size: {(intake._count?.householdMembers || 0) + 1}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-3 flex-shrink-0 ml-2">
                      {intake.riskScore && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RISK_COLORS[intake.riskScore]}`}>
                          {intake.riskScore}
                        </span>
                      )}
                      <span className="text-xs text-gray-500 hidden sm:inline">{intake.status}</span>
                      <span className="text-gray-300" aria-hidden="true">{"\u203A"}</span>
                    </div>
                  </Link>
                ))}
              </div>
            </nav>
          )}
        </main>
      </div>
    </>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3 sm:p-4">
      <p className="text-xs text-gray-500 uppercase">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold ${color || "text-gray-800"}`}>{value}</p>
    </div>
  );
}
