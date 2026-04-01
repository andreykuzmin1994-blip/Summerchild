import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";

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
  const navigate = useNavigate();

  const token = localStorage.getItem("token");
  const caseworker = JSON.parse(localStorage.getItem("caseworker") || "{}");

  useEffect(() => {
    if (!token) {
      navigate("/login");
      return;
    }
    loadDashboard();
  }, [filter]);

  const loadDashboard = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter) params.set("riskScore", filter);

      const res = await fetch(`/api/caseworker/dashboard?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 401) {
        localStorage.removeItem("token");
        navigate("/login");
        return;
      }

      const data = await res.json();
      setIntakes(data.intakes || []);
      setStats(data.stats || {});
    } catch (error) {
      console.error("Failed to load dashboard:", error);
    }
    setLoading(false);
  };

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("caseworker");
    navigate("/login");
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-gray-800">Cushion Gov</h1>
          <p className="text-xs text-gray-500">Caseworker Dashboard</p>
        </div>
        <div className="flex items-center space-x-4">
          <span className="text-sm text-gray-600">{caseworker.name}</span>
          <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800">
            Sign Out
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto p-6">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <StatCard label="Today" value={stats.intakesToday || 0} />
          <StatCard label="This Week" value={stats.intakesThisWeek || 0} />
          <StatCard label="Flagged" value={stats.flaggedIntakes || 0} color="text-red-600" />
        </div>

        {/* Filters */}
        <div className="flex items-center space-x-2 mb-4">
          <span className="text-sm text-gray-500">Filter:</span>
          {["", "LOW", "MEDIUM", "HIGH"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
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

        {/* Intake list */}
        {loading ? (
          <p className="text-gray-500 text-center py-8">Loading...</p>
        ) : intakes.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No intakes found</p>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {intakes.map((intake) => (
              <Link
                key={intake.id}
                to={`/caseworker/intake/${intake.id}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center space-x-3">
                  {intake.expeditedFlag && (
                    <span className="bg-red-500 text-white text-xs px-2 py-0.5 rounded font-medium">
                      EXPEDITED
                    </span>
                  )}
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {intake.applicant
                        ? `${intake.applicant.firstName} ${intake.applicant.lastName}`
                        : `Intake #${intake.id.slice(0, 8)}`}
                    </p>
                    <p className="text-xs text-gray-500">
                      {new Date(intake.createdAt).toLocaleString()} | HH size: {(intake._count?.householdMembers || 0) + 1}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-3">
                  {intake.riskScore && (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RISK_COLORS[intake.riskScore]}`}>
                      {intake.riskScore}
                    </span>
                  )}
                  <span className="text-xs text-gray-400">{intake.status}</span>
                  <span className="text-gray-300">{"\u203A"}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <p className="text-xs text-gray-500 uppercase">{label}</p>
      <p className={`text-2xl font-bold ${color || "text-gray-800"}`}>{value}</p>
    </div>
  );
}
