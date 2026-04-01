import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";

const EVENT_TYPE_LABELS = {
  INTAKE_CREATED: "Intake Created",
  INTAKE_COMPLETED: "Intake Completed",
  INTAKE_ABANDONED: "Intake Abandoned",
  INTAKE_TIMED_OUT: "Intake Timed Out",
  AI_API_CALL: "AI API Call",
  INJECTION_BLOCKED: "Injection Blocked",
  PII_STRIPPED: "PII Stripped",
  CASEWORKER_LOGIN: "Caseworker Login",
  CASEWORKER_LOGOUT: "Caseworker Logout",
  CASEWORKER_VIEWED_INTAKE: "Viewed Intake",
  CASEWORKER_REVIEWED_INTAKE: "Reviewed Intake",
  CASEWORKER_CORRECTION: "Correction Made",
  DATA_EXPORT: "Data Export",
  ADMIN_USER_CREATED: "User Created",
  ADMIN_USER_MODIFIED: "User Modified",
  ADMIN_USER_DEACTIVATED: "User Deactivated",
};

const EVENT_CATEGORIES = {
  "Intake Events": ["INTAKE_CREATED", "INTAKE_COMPLETED", "INTAKE_ABANDONED", "INTAKE_TIMED_OUT"],
  "Caseworker Events": ["CASEWORKER_LOGIN", "CASEWORKER_LOGOUT", "CASEWORKER_VIEWED_INTAKE", "CASEWORKER_REVIEWED_INTAKE", "CASEWORKER_CORRECTION"],
  "Security Events": ["AI_API_CALL", "INJECTION_BLOCKED", "PII_STRIPPED"],
  "Admin Events": ["ADMIN_USER_CREATED", "ADMIN_USER_MODIFIED", "ADMIN_USER_DEACTIVATED", "DATA_EXPORT"],
};

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState("stats");
  const [stats, setStats] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Registration form
  const [regForm, setRegForm] = useState({ name: "", email: "", password: "", role: "CASEWORKER" });
  const [regStatus, setRegStatus] = useState(null);
  const [regLoading, setRegLoading] = useState(false);

  const navigate = useNavigate();
  const token = localStorage.getItem("token");
  const caseworker = JSON.parse(localStorage.getItem("caseworker") || "{}");
  const AUDIT_LIMIT = 50;

  useEffect(() => {
    if (!token) { navigate("/login"); return; }
    if (caseworker.role !== "ADMIN") {
      navigate("/caseworker/dashboard");
      return;
    }
  }, []);

  useEffect(() => {
    if (activeTab === "stats") loadStats();
    if (activeTab === "audit") loadAuditLogs();
  }, [activeTab, auditOffset, eventTypeFilter]);

  const loadStats = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/stats", { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { navigate("/login"); return; }
      if (!res.ok) throw new Error("Failed to load statistics");
      setStats(await res.json());
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const loadAuditLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: AUDIT_LIMIT, offset: auditOffset });
      if (eventTypeFilter) params.set("eventType", eventTypeFilter);
      const res = await fetch(`/api/admin/audit-log?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { navigate("/login"); return; }
      if (!res.ok) throw new Error("Failed to load audit logs");
      const data = await res.json();
      setAuditLogs(data.logs || []);
      setAuditTotal(data.total || 0);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setRegLoading(true);
    setRegStatus(null);
    try {
      const res = await fetch("/api/caseworker/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(regForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Registration failed");
      setRegStatus({ type: "success", message: `Successfully registered ${data.name} (${data.email})` });
      setRegForm({ name: "", email: "", password: "", role: "CASEWORKER" });
    } catch (err) {
      setRegStatus({ type: "error", message: err.message });
    }
    setRegLoading(false);
  };

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("caseworker");
    navigate("/login");
  };

  const tabs = [
    { key: "stats", label: "System Stats" },
    { key: "audit", label: "Audit Log" },
    { key: "users", label: "User Management" },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-gray-800">Cushion Gov</h1>
          <p className="text-xs text-gray-500">System Administration</p>
        </div>
        <div className="flex items-center space-x-4">
          <span className="text-sm text-gray-600 hidden sm:inline">{caseworker.name}</span>
          <Link to="/supervisor/dashboard" className="text-sm text-cushion-600 hover:text-cushion-800">
            Supervisor View
          </Link>
          <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800" aria-label="Sign out">
            Sign Out
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto p-4 sm:p-6">
        {/* Tabs */}
        <nav className="flex space-x-1 mb-6 border-b border-gray-200" role="tablist" aria-label="Admin sections">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => { setActiveTab(tab.key); setError(null); }}
              role="tab"
              aria-selected={activeTab === tab.key}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-cushion-600 text-cushion-700"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6" role="alert">
            <p className="text-red-800 text-sm">{error}</p>
            <button onClick={() => { if (activeTab === "stats") loadStats(); else loadAuditLogs(); }}
              className="mt-1 text-sm text-red-700 underline hover:text-red-900">
              Try again
            </button>
          </div>
        )}

        {/* Stats Tab */}
        {activeTab === "stats" && (
          <section aria-label="System statistics" role="tabpanel">
            {loading ? (
              <p className="text-gray-500 text-center py-8" role="status">Loading statistics...</p>
            ) : stats ? (
              <div className="space-y-6">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  <StatCard label="Total Intakes" value={stats.totalIntakes || 0} />
                  <StatCard label="Completed" value={stats.completedIntakes || 0} />
                  <StatCard label="Reviewed" value={stats.reviewedIntakes || 0} />
                  <StatCard label="Expedited" value={stats.expeditedCount || 0} color="text-red-600" />
                  <StatCard label="High Risk" value={stats.highRiskCount || 0} color="text-red-600" />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <StatCard label="Today" value={stats.intakesToday || 0} />
                  <StatCard label="This Week" value={stats.intakesThisWeek || 0} />
                  <StatCard label="This Month" value={stats.intakesThisMonth || 0} />
                  <StatCard
                    label="Completion Rate"
                    value={stats.completionRate ? `${(stats.completionRate * 100).toFixed(0)}%` : "N/A"}
                  />
                </div>
                {stats.correctionRate !== undefined && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                    <p className="text-sm text-yellow-800">
                      <strong>Correction Rate:</strong> {(stats.correctionRate * 100).toFixed(1)}% of reviewed intakes required corrections
                    </p>
                  </div>
                )}
              </div>
            ) : null}
          </section>
        )}

        {/* Audit Log Tab */}
        {activeTab === "audit" && (
          <section aria-label="Audit log" role="tabpanel">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-4 gap-2">
              <p className="text-sm text-gray-500">
                Showing {auditLogs.length} of {auditTotal} events
              </p>
              <select
                value={eventTypeFilter}
                onChange={(e) => { setEventTypeFilter(e.target.value); setAuditOffset(0); }}
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-full sm:w-auto"
                aria-label="Filter by event type"
              >
                <option value="">All Events</option>
                {Object.entries(EVENT_CATEGORIES).map(([category, types]) => (
                  <optgroup key={category} label={category}>
                    {types.map((type) => (
                      <option key={type} value={type}>{EVENT_TYPE_LABELS[type] || type}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {loading ? (
              <p className="text-gray-500 text-center py-8" role="status">Loading audit logs...</p>
            ) : auditLogs.length === 0 ? (
              <p className="text-gray-500 text-center py-8">No audit events found</p>
            ) : (
              <>
                <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
                  <table className="w-full text-sm" role="table">
                    <thead>
                      <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                        <th className="px-4 py-3 font-medium">Timestamp</th>
                        <th className="px-4 py-3 font-medium">Event</th>
                        <th className="px-4 py-3 font-medium hidden sm:table-cell">Actor</th>
                        <th className="px-4 py-3 font-medium hidden md:table-cell">Intake</th>
                        <th className="px-4 py-3 font-medium hidden lg:table-cell">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {auditLogs.map((log) => (
                        <tr key={log.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                            {new Date(log.timestamp).toLocaleString()}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                              log.eventType.includes("BLOCKED") ? "bg-red-100 text-red-800" :
                              log.eventType.includes("LOGIN") || log.eventType.includes("CREATED") ? "bg-green-100 text-green-800" :
                              log.eventType.includes("REVIEWED") || log.eventType.includes("CORRECTION") ? "bg-blue-100 text-blue-800" :
                              "bg-gray-100 text-gray-800"
                            }`}>
                              {EVENT_TYPE_LABELS[log.eventType] || log.eventType}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-600 hidden sm:table-cell">
                            {log.actorType}{log.actorId ? ` #${log.actorId.slice(0, 6)}` : ""}
                          </td>
                          <td className="px-4 py-3 hidden md:table-cell">
                            {log.intakeId ? (
                              <Link to={`/caseworker/intake/${log.intakeId}`} className="text-cushion-600 hover:text-cushion-800">
                                #{log.intakeId.slice(0, 8)}
                              </Link>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500 hidden lg:table-cell max-w-xs truncate">
                            {log.details ? JSON.stringify(log.details).slice(0, 100) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div className="flex items-center justify-between mt-4">
                  <button
                    onClick={() => setAuditOffset(Math.max(0, auditOffset - AUDIT_LIMIT))}
                    disabled={auditOffset === 0}
                    className="text-sm px-4 py-2 border border-gray-300 rounded-lg disabled:opacity-50 hover:bg-gray-50"
                  >
                    Previous
                  </button>
                  <span className="text-sm text-gray-500">
                    Page {Math.floor(auditOffset / AUDIT_LIMIT) + 1} of {Math.ceil(auditTotal / AUDIT_LIMIT) || 1}
                  </span>
                  <button
                    onClick={() => setAuditOffset(auditOffset + AUDIT_LIMIT)}
                    disabled={auditOffset + AUDIT_LIMIT >= auditTotal}
                    className="text-sm px-4 py-2 border border-gray-300 rounded-lg disabled:opacity-50 hover:bg-gray-50"
                  >
                    Next
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {/* User Management Tab */}
        {activeTab === "users" && (
          <section aria-label="User management" role="tabpanel">
            <div className="max-w-lg">
              <h2 className="font-bold text-gray-700 mb-4">Register New Caseworker</h2>

              {regStatus && (
                <div className={`rounded-lg p-3 mb-4 text-sm ${
                  regStatus.type === "success" ? "bg-green-50 text-green-800 border border-green-200" :
                  "bg-red-50 text-red-800 border border-red-200"
                }`} role="alert">
                  {regStatus.message}
                </div>
              )}

              <form onSubmit={handleRegister} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
                <div>
                  <label htmlFor="reg-name" className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                  <input
                    id="reg-name"
                    type="text"
                    value={regForm.name}
                    onChange={(e) => setRegForm({ ...regForm, name: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cushion-500"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="reg-email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    id="reg-email"
                    type="email"
                    value={regForm.email}
                    onChange={(e) => setRegForm({ ...regForm, email: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cushion-500"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="reg-password" className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                  <input
                    id="reg-password"
                    type="password"
                    value={regForm.password}
                    onChange={(e) => setRegForm({ ...regForm, password: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cushion-500"
                    required
                    minLength={8}
                  />
                </div>
                <div>
                  <label htmlFor="reg-role" className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                  <select
                    id="reg-role"
                    value={regForm.role}
                    onChange={(e) => setRegForm({ ...regForm, role: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="CASEWORKER">Caseworker</option>
                    <option value="SUPERVISOR">Supervisor</option>
                    <option value="ADMIN">Admin</option>
                  </select>
                </div>
                <button
                  type="submit"
                  disabled={regLoading}
                  className="bg-cushion-600 text-white rounded-lg px-6 py-2 text-sm font-medium hover:bg-cushion-700 disabled:opacity-50 transition-colors"
                >
                  {regLoading ? "Registering..." : "Register User"}
                </button>
              </form>
            </div>
          </section>
        )}
      </div>
    </div>
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
