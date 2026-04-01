import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import ErrorBanner from "../components/ErrorBanner";
import SkipLink from "../components/SkipLink";

export default function SupervisorDashboard() {
  const [stats, setStats] = useState(null);
  const [intakes, setIntakes] = useState([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exportLoading, setExportLoading] = useState(false);
  const navigate = useNavigate();

  const token = localStorage.getItem("token");
  const caseworker = JSON.parse(localStorage.getItem("caseworker") || "{}");

  useEffect(() => {
    if (!token) { navigate("/login"); return; }
    if (caseworker.role !== "SUPERVISOR" && caseworker.role !== "ADMIN") {
      navigate("/caseworker/dashboard");
      return;
    }
    loadData();
  }, [filter]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filter) params.set("riskScore", filter);

      const [statsRes, intakesRes] = await Promise.all([
        fetch("/api/admin/stats", { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/caseworker/dashboard?${params}`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);

      if (statsRes.status === 401 || intakesRes.status === 401) {
        localStorage.removeItem("token");
        navigate("/login");
        return;
      }

      if (statsRes.status === 429 || intakesRes.status === 429) throw new Error("Too many requests. Please wait a moment.");
      if (!statsRes.ok) throw new Error("Failed to load statistics");
      if (!intakesRes.ok) throw new Error("Failed to load intakes");

      const statsData = await statsRes.json();
      const intakesData = await intakesRes.json();
      setStats(statsData);
      setIntakes(intakesData.intakes || []);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const handleExport = async () => {
    setExportLoading(true);
    try {
      const res = await fetch("/api/admin/export/intakes", { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { navigate("/login"); return; }
      if (!res.ok) throw new Error("Failed to export data");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `intakes-export-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    }
    setExportLoading(false);
  };

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("caseworker");
    navigate("/login");
  };

  return (
    <>
    <SkipLink />
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-gray-800">Cushion Gov</h1>
          <p className="text-xs text-gray-500">Supervisor Dashboard</p>
        </div>
        <nav className="flex items-center space-x-4" aria-label="User menu">
          <span className="text-sm text-gray-600 hidden sm:inline">{caseworker.name}</span>
          <Link to="/caseworker/dashboard" className="text-sm text-cushion-600 hover:text-cushion-800">
            Caseworker View
          </Link>
          <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800" aria-label="Sign out">
            Sign Out
          </button>
        </nav>
      </header>

      <main id="main-content" className="max-w-6xl mx-auto p-4 sm:p-6" role="main">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6" role="alert">
            <p className="text-red-800 text-sm font-medium">Error loading data</p>
            <p className="text-red-600 text-sm">{error}</p>
            <button onClick={loadData} className="mt-2 text-sm text-red-700 underline hover:text-red-900">
              Try again
            </button>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12" role="status" aria-label="Loading dashboard">
            <p className="text-gray-500">Loading supervisor dashboard...</p>
          </div>
        ) : (
          <>
            {/* County Stats Overview */}
            {stats && (
              <section aria-label="County statistics">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-bold text-gray-700 text-sm uppercase tracking-wide">County Performance</h2>
                  <button
                    onClick={handleExport}
                    disabled={exportLoading}
                    className="text-sm border border-cushion-300 text-cushion-700 rounded-lg px-4 py-2 hover:bg-cushion-50 disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500"
                    aria-label="Export intakes as CSV"
                  >
                    {exportLoading ? "Exporting..." : "Export CSV"}
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
                  <StatCard label="Total Intakes" value={stats.totalIntakes || 0} />
                  <StatCard label="Completed" value={stats.completedIntakes || 0} />
                  <StatCard label="Reviewed" value={stats.reviewedIntakes || 0} />
                  <StatCard label="Expedited" value={stats.expeditedCount || 0} color="text-red-600" />
                  <StatCard label="High Risk" value={stats.highRiskCount || 0} color="text-red-600" />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                  <StatCard label="Today" value={stats.intakesToday || 0} />
                  <StatCard label="This Week" value={stats.intakesThisWeek || 0} />
                  <StatCard label="This Month" value={stats.intakesThisMonth || 0} />
                  <StatCard label="Completion Rate" value={stats.completionRate || "N/A"} />
                </div>
                {stats.correctionRate && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
                    <p className="text-sm text-yellow-800">
                      <strong>Correction Rate:</strong> {stats.correctionRate} of reviewed intakes required corrections
                    </p>
                  </div>
                )}
              </section>
            )}

            {/* Intake Queue */}
            <section aria-label="Intake queue">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-4 gap-2">
                <h2 className="font-bold text-gray-700 text-sm uppercase tracking-wide">Intake Queue</h2>
                <div className="flex items-center space-x-2" role="group" aria-label="Filter by risk level">
                  <span className="text-sm text-gray-500">Filter:</span>
                  {["", "LOW", "MEDIUM", "HIGH"].map((f) => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      aria-pressed={filter === f}
                      className={`text-xs px-3 py-1 rounded-full border ${
                        filter === f
                          ? "bg-cushion-600 text-white border-cushion-600"
                          : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      {f || "All"}
                    </button>
                  ))}
                </div>
              </div>

              {intakes.length === 0 ? (
                <p className="text-gray-500 text-center py-8">No intakes found</p>
              ) : (
                <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100 overflow-x-auto">
                  <table className="w-full text-sm" role="table">
                    <thead>
                      <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                        <th className="px-4 py-3 font-medium">Applicant</th>
                        <th className="px-4 py-3 font-medium hidden sm:table-cell">Date</th>
                        <th className="px-4 py-3 font-medium">HH Size</th>
                        <th className="px-4 py-3 font-medium">Risk</th>
                        <th className="px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3 font-medium"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {intakes.map((intake) => (
                        <tr key={intake.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3">
                            <div className="flex items-center space-x-2">
                              {intake.expeditedFlag && (
                                <span className="bg-red-500 text-white text-xs px-1.5 py-0.5 rounded font-medium">EXP</span>
                              )}
                              <span className="font-medium text-gray-800">
                                {intake.applicant
                                  ? `${intake.applicant.firstName} ${intake.applicant.lastName}`
                                  : `#${intake.id.slice(0, 8)}`}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">
                            {new Date(intake.createdAt).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-3 text-gray-600">
                            {(intake._count?.householdMembers || 0) + 1}
                          </td>
                          <td className="px-4 py-3">
                            {intake.riskScore && (
                              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                                intake.riskScore === "HIGH" ? "bg-red-100 text-red-800" :
                                intake.riskScore === "MEDIUM" ? "bg-yellow-100 text-yellow-800" :
                                "bg-green-100 text-green-800"
                              }`}>
                                {intake.riskScore}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-400">{intake.status}</td>
                          <td className="px-4 py-3">
                            <Link
                              to={`/caseworker/intake/${intake.id}`}
                              className="text-cushion-600 hover:text-cushion-800 text-sm font-medium"
                            >
                              View
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
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
