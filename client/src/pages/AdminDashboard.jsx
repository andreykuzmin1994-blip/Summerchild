import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import ErrorBanner from "../components/ErrorBanner";
import SkipLink from "../components/SkipLink";

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

function authFetch(url, _token, options = {}) {
  return fetch(url, { ...options, credentials: "include", headers: { ...options.headers } });
}

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState("stats");
  const [stats, setStats] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // User management
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [regForm, setRegForm] = useState({ name: "", email: "", password: "", role: "CASEWORKER" });
  const [regStatus, setRegStatus] = useState(null);
  const [regLoading, setRegLoading] = useState(false);
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [actionStatus, setActionStatus] = useState(null);

  // Export
  const [exportLoading, setExportLoading] = useState(false);

  const navigate = useNavigate();
  const caseworker = JSON.parse(localStorage.getItem("caseworker") || "{}");
  const token = "cookie"; // Token is now in httpOnly cookie; this variable is kept for authFetch signature compatibility
  const AUDIT_LIMIT = 50;

  useEffect(() => {
    if (!caseworker.id) { navigate("/login"); return; }
    if (caseworker.role !== "ADMIN") {
      navigate("/caseworker/dashboard");
      return;
    }
  }, []);

  useEffect(() => {
    if (activeTab === "stats") loadStats();
    if (activeTab === "audit") loadAuditLogs();
    if (activeTab === "users") loadUsers();
  }, [activeTab, auditOffset, eventTypeFilter]);

  const handleAuthError = (res) => {
    if (res.status === 401) { localStorage.removeItem("caseworker"); navigate("/login"); return true; }
    if (res.status === 429) { setError("Too many requests. Please wait a moment."); return true; }
    return false;
  };

  const loadStats = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch("/api/admin/stats", token);
      if (handleAuthError(res)) return;
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
      const res = await authFetch(`/api/admin/audit-log?${params}`, token);
      if (handleAuthError(res)) return;
      if (!res.ok) throw new Error("Failed to load audit logs");
      const data = await res.json();
      setAuditLogs(data.logs || []);
      setAuditTotal(data.total || 0);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const loadUsers = async () => {
    setUsersLoading(true);
    setError(null);
    try {
      const res = await authFetch("/api/caseworker/users", token);
      if (handleAuthError(res)) return;
      if (!res.ok) throw new Error("Failed to load users");
      setUsers(await res.json());
    } catch (err) {
      setError(err.message);
    }
    setUsersLoading(false);
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setRegLoading(true);
    setRegStatus(null);
    try {
      const res = await authFetch("/api/caseworker/register", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(regForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Registration failed");
      setRegStatus({ type: "success", message: `Registered ${data.name} (${data.email}) as ${data.role}` });
      setRegForm({ name: "", email: "", password: "", role: "CASEWORKER" });
      loadUsers();
    } catch (err) {
      setRegStatus({ type: "error", message: err.message });
    }
    setRegLoading(false);
  };

  const handleRoleChange = async (userId, newRole) => {
    setActionStatus(null);
    try {
      const res = await authFetch(`/api/caseworker/users/${userId}`, token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed to update role"); }
      setActionStatus({ type: "success", message: "Role updated successfully" });
      loadUsers();
    } catch (err) {
      setActionStatus({ type: "error", message: err.message });
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setResetLoading(true);
    setActionStatus(null);
    try {
      const res = await authFetch(`/api/caseworker/users/${resetTarget.id}/reset-password`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: resetPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to reset password");
      setActionStatus({ type: "success", message: `Password reset for ${resetTarget.name}` });
      setResetTarget(null);
      setResetPassword("");
    } catch (err) {
      setActionStatus({ type: "error", message: err.message });
    }
    setResetLoading(false);
  };

  const handleDeactivate = async (user) => {
    if (!window.confirm(`Are you sure you want to deactivate ${user.name} (${user.email})? This cannot be undone.`)) return;
    setActionStatus(null);
    try {
      const res = await authFetch(`/api/caseworker/users/${user.id}`, token, { method: "DELETE" });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed to deactivate"); }
      setActionStatus({ type: "success", message: `${user.name} has been deactivated` });
      loadUsers();
    } catch (err) {
      setActionStatus({ type: "error", message: err.message });
    }
  };

  const handleExport = async () => {
    setExportLoading(true);
    try {
      const res = await authFetch("/api/admin/export/intakes", token);
      if (handleAuthError(res)) return;
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
    localStorage.removeItem("caseworker");
    localStorage.removeItem("caseworker");
    navigate("/login");
  };

  const tabs = [
    { key: "stats", label: "System Stats" },
    { key: "audit", label: "Audit Log" },
    { key: "users", label: "User Management" },
  ];

  return (
    <>
      <SkipLink />
      <div className="min-h-screen bg-gray-50">
        <header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-gray-800">Cushion Gov</h1>
            <p className="text-xs text-gray-500">System Administration</p>
          </div>
          <nav className="flex items-center space-x-4" aria-label="User menu">
            <span className="text-sm text-gray-600 hidden sm:inline">{caseworker.name}</span>
            <Link to="/supervisor/dashboard" className="text-sm text-cushion-600 hover:text-cushion-800">
              Supervisor View
            </Link>
            <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800" aria-label="Sign out">
              Sign Out
            </button>
          </nav>
        </header>

        <main id="main-content" className="max-w-6xl mx-auto p-4 sm:p-6" role="main">
          {/* Tabs */}
          <div className="flex space-x-1 mb-6 border-b border-gray-200" role="tablist" aria-label="Admin sections">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => { setActiveTab(tab.key); setError(null); setActionStatus(null); }}
                role="tab"
                aria-selected={activeTab === tab.key}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500 ${
                  activeTab === tab.key
                    ? "border-cushion-600 text-cushion-700"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <ErrorBanner message={error} onRetry={() => {
            if (activeTab === "stats") loadStats();
            else if (activeTab === "audit") loadAuditLogs();
            else loadUsers();
          }} />

          {/* Stats Tab */}
          {activeTab === "stats" && (
            <section aria-label="System statistics" role="tabpanel">
              {loading ? (
                <p className="text-gray-500 text-center py-8" role="status">Loading statistics...</p>
              ) : stats ? (
                <div className="space-y-6">
                  <div className="flex justify-end">
                    <button
                      onClick={handleExport}
                      disabled={exportLoading}
                      className="text-sm border border-cushion-300 text-cushion-700 rounded-lg px-4 py-2 hover:bg-cushion-50 disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500"
                      aria-label="Export intakes as CSV"
                    >
                      {exportLoading ? "Exporting..." : "Export Intakes (CSV)"}
                    </button>
                  </div>
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
                    <StatCard label="Completion Rate" value={stats.completionRate || "N/A"} />
                  </div>
                  {stats.correctionRate && (
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <p className="text-sm text-yellow-800">
                        <strong>Correction Rate:</strong> {stats.correctionRate} of reviewed intakes required corrections
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
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-full sm:w-auto focus:outline-none focus:ring-2 focus:ring-cushion-500"
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

                  <div className="flex items-center justify-between mt-4">
                    <button
                      onClick={() => setAuditOffset(Math.max(0, auditOffset - AUDIT_LIMIT))}
                      disabled={auditOffset === 0}
                      className="text-sm px-4 py-2 border border-gray-300 rounded-lg disabled:opacity-50 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-cushion-500"
                    >
                      Previous
                    </button>
                    <span className="text-sm text-gray-500">
                      Page {Math.floor(auditOffset / AUDIT_LIMIT) + 1} of {Math.ceil(auditTotal / AUDIT_LIMIT) || 1}
                    </span>
                    <button
                      onClick={() => setAuditOffset(auditOffset + AUDIT_LIMIT)}
                      disabled={auditOffset + AUDIT_LIMIT >= auditTotal}
                      className="text-sm px-4 py-2 border border-gray-300 rounded-lg disabled:opacity-50 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-cushion-500"
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
              {actionStatus && (
                <div className={`rounded-lg p-3 mb-4 text-sm ${
                  actionStatus.type === "success" ? "bg-green-50 text-green-800 border border-green-200" :
                  "bg-red-50 text-red-800 border border-red-200"
                }`} role="alert">
                  {actionStatus.message}
                </div>
              )}

              {/* Existing Users */}
              <div className="mb-8">
                <h2 className="font-bold text-gray-700 mb-4">Current Users ({users.length})</h2>
                {usersLoading ? (
                  <p className="text-gray-500 text-center py-4" role="status">Loading users...</p>
                ) : users.length === 0 ? (
                  <p className="text-gray-500 text-center py-4">No users found</p>
                ) : (
                  <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
                    <table className="w-full text-sm" role="table">
                      <thead>
                        <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                          <th className="px-4 py-3 font-medium">Name</th>
                          <th className="px-4 py-3 font-medium hidden sm:table-cell">Email</th>
                          <th className="px-4 py-3 font-medium">Role</th>
                          <th className="px-4 py-3 font-medium hidden md:table-cell">Reviews</th>
                          <th className="px-4 py-3 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {users.map((user) => (
                          <tr key={user.id} className="hover:bg-gray-50">
                            <td className="px-4 py-3">
                              <p className="font-medium text-gray-800">{user.name}</p>
                              <p className="text-xs text-gray-500 sm:hidden">{user.email}</p>
                            </td>
                            <td className="px-4 py-3 text-gray-600 hidden sm:table-cell">{user.email}</td>
                            <td className="px-4 py-3">
                              <select
                                value={user.role}
                                onChange={(e) => handleRoleChange(user.id, e.target.value)}
                                disabled={user.id === caseworker.id}
                                className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-cushion-500 disabled:opacity-50"
                                aria-label={`Change role for ${user.name}`}
                              >
                                <option value="CASEWORKER">Caseworker</option>
                                <option value="SUPERVISOR">Supervisor</option>
                                <option value="ADMIN">Admin</option>
                              </select>
                            </td>
                            <td className="px-4 py-3 text-gray-500 hidden md:table-cell">
                              {user._count?.reviews || 0} reviews, {user._count?.intakes || 0} assigned
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center space-x-2">
                                <button
                                  onClick={() => { setResetTarget(user); setResetPassword(""); setActionStatus(null); }}
                                  className="text-xs text-cushion-600 hover:text-cushion-800 underline focus:outline-none focus:ring-2 focus:ring-cushion-500 rounded"
                                >
                                  Reset Password
                                </button>
                                {user.id !== caseworker.id && (
                                  <button
                                    onClick={() => handleDeactivate(user)}
                                    className="text-xs text-red-600 hover:text-red-800 underline focus:outline-none focus:ring-2 focus:ring-red-500 rounded"
                                  >
                                    Deactivate
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Password Reset Dialog */}
              {resetTarget && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-label="Reset password">
                  <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
                    <h3 className="font-bold text-gray-800 mb-1">Reset Password</h3>
                    <p className="text-sm text-gray-500 mb-4">For: {resetTarget.name} ({resetTarget.email})</p>
                    <form onSubmit={handleResetPassword} className="space-y-4">
                      <div>
                        <label htmlFor="new-password" className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
                        <input
                          id="new-password"
                          type="password"
                          value={resetPassword}
                          onChange={(e) => setResetPassword(e.target.value)}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cushion-500"
                          required
                          minLength={8}
                        />
                        <p className="text-xs text-gray-400 mt-1">Minimum 8 characters</p>
                      </div>
                      <div className="flex space-x-3">
                        <button
                          type="submit"
                          disabled={resetLoading}
                          className="flex-1 bg-cushion-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-cushion-700 disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500"
                        >
                          {resetLoading ? "Resetting..." : "Reset Password"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setResetTarget(null)}
                          className="flex-1 border border-gray-300 text-gray-700 rounded-lg py-2 text-sm font-medium hover:bg-gray-50 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-400"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}

              {/* Register New User */}
              <div className="max-w-lg">
                <h2 className="font-bold text-gray-700 mb-4">Register New User</h2>

                {regStatus && (
                  <div className={`rounded-lg p-3 mb-4 text-sm ${
                    regStatus.type === "success" ? "bg-green-50 text-green-800 border border-green-200" :
                    "bg-red-50 text-red-800 border border-red-200"
                  }`} role="alert">
                    {regStatus.message}
                  </div>
                )}

                <form onSubmit={handleRegister} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4" aria-label="Register new user">
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
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cushion-500"
                    >
                      <option value="CASEWORKER">Caseworker</option>
                      <option value="SUPERVISOR">Supervisor</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                  </div>
                  <button
                    type="submit"
                    disabled={regLoading}
                    className="bg-cushion-600 text-white rounded-lg px-6 py-2 text-sm font-medium hover:bg-cushion-700 disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500 focus:ring-offset-2"
                  >
                    {regLoading ? "Registering..." : "Register User"}
                  </button>
                </form>
              </div>
            </section>
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
