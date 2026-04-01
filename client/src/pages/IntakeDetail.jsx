import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import IncomeCalculationDisplay from "../components/IncomeCalculationDisplay";
import DocumentChecklist from "../components/DocumentChecklist";
import ErrorBanner from "../components/ErrorBanner";
import SkipLink from "../components/SkipLink";

const RISK_COLORS = {
  LOW: "bg-green-500",
  MEDIUM: "bg-yellow-500",
  HIGH: "bg-red-500",
};

export default function IntakeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [intake, setIntake] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const [reviewForm, setReviewForm] = useState({ correctionsMade: false, correctionType: "", notes: "" });
  const [error, setError] = useState(null);
  const [reviewError, setReviewError] = useState(null);

  const token = localStorage.getItem("token");

  useEffect(() => {
    if (!token) { navigate("/login"); return; }
    loadIntake();
  }, [id]);

  const loadIntake = async () => {
    setError(null);
    try {
      const res = await fetch(`/api/caseworker/intake/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { navigate("/login"); return; }
      if (!res.ok) throw new Error("Failed to load intake details. Please try again.");
      const data = await res.json();
      setIntake(data);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const submitReview = async () => {
    setReviewing(true);
    setReviewError(null);
    try {
      const res = await fetch(`/api/caseworker/intake/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(reviewForm),
      });
      if (!res.ok) throw new Error("Failed to submit review. Please try again.");
      loadIntake();
    } catch (err) {
      setReviewError(err.message);
    }
    setReviewing(false);
  };

  if (loading) {
    return (
      <div className="p-8 text-center text-gray-500" role="status" aria-label="Loading intake">
        Loading intake details...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 max-w-md mx-auto">
        <ErrorBanner message={error} onRetry={loadIntake} />
      </div>
    );
  }

  if (!intake) {
    return (
      <div className="p-8 text-center">
        <p className="text-red-500 mb-4">Intake not found</p>
        <button
          onClick={() => navigate("/caseworker/dashboard")}
          className="text-cushion-600 hover:text-cushion-800 text-sm underline"
        >
          Return to Dashboard
        </button>
      </div>
    );
  }

  const flags = intake.consistencyFlags || [];

  return (
    <>
      <SkipLink />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-center space-x-4">
            <button
              onClick={() => navigate("/caseworker/dashboard")}
              className="text-cushion-600 hover:text-cushion-800 text-sm focus:outline-none focus:ring-2 focus:ring-cushion-500 rounded"
              aria-label="Return to dashboard"
            >
              {"\u2190"} Dashboard
            </button>
            <div>
              <h1 className="text-base sm:text-lg font-bold text-gray-800">
                CUSHION INTAKE SUMMARY
              </h1>
              <p className="text-xs text-gray-500">
                Intake #{intake.id.slice(0, 8).toUpperCase()} | {new Date(intake.createdAt).toLocaleString()}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-3 ml-auto sm:ml-0">
            {intake.expeditedFlag && (
              <span className="bg-red-500 text-white text-xs sm:text-sm px-2 sm:px-3 py-1 rounded font-bold" role="status">
                EXPEDITED
              </span>
            )}
            {intake.riskScore && (
              <div className="flex items-center space-x-1">
                <span className={`w-3 h-3 rounded-full ${RISK_COLORS[intake.riskScore]}`} aria-hidden="true" />
                <span className="text-sm font-medium">{intake.riskScore} RISK</span>
              </div>
            )}
          </div>
        </header>

        <main id="main-content" className="max-w-4xl mx-auto p-4 sm:p-6 space-y-6" role="main">
          {/* Expedited banner */}
          {intake.expeditedFlag && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4" role="alert">
              <p className="text-red-800 font-bold">EXPEDITED: 7-day processing required</p>
              <p className="text-red-600 text-sm">{intake.expeditedReason}</p>
            </div>
          )}

          {/* Flags */}
          {flags.length > 0 && (
            <section aria-label="Data consistency flags">
              <h2 className="font-bold text-gray-700 mb-2">FLAGS ({flags.length})</h2>
              <div className="space-y-2">
                {flags.map((flag, i) => (
                  <div key={i} className={`rounded-lg p-3 ${
                    flag.severity === "HIGH" ? "bg-red-50 border border-red-200" :
                    flag.severity === "MEDIUM" ? "bg-yellow-50 border border-yellow-200" :
                    "bg-blue-50 border border-blue-200"
                  }`} role="alert">
                    <p className="text-sm font-medium">
                      <span aria-hidden="true">
                        {flag.severity === "HIGH" || flag.severity === "MEDIUM" ? "\u26A0\uFE0F" : "\u2139\uFE0F"}{" "}
                      </span>
                      {flag.severity}: {flag.message}
                    </p>
                    {flag.suggestedAction && (
                      <p className="text-xs text-gray-600 mt-1">Action: {flag.suggestedAction}</p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Applicant Details */}
          {intake.applicant && (
            <Section title="APPLICANT INFORMATION">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                <Field label="Name" value={`${intake.applicant.firstName} ${intake.applicant.lastName}`} />
                {intake.applicant.dob && (
                  <Field label="Date of Birth" value={new Date(intake.applicant.dob).toLocaleDateString()} />
                )}
                {intake.applicant.ssnLastFour && (
                  <Field label="SSN (last 4)" value={`***-**-${intake.applicant.ssnLastFour}`} />
                )}
                {intake.applicant.citizenshipStatus && (
                  <Field label="Citizenship" value={formatCitizenship(intake.applicant.citizenshipStatus)} />
                )}
                {intake.applicant.languagePreference && (
                  <Field label="Language" value={intake.applicant.languagePreference === "es" ? "Spanish" : "English"} />
                )}
                {intake.applicant.phone && (
                  <Field label="Phone" value={intake.applicant.phone} />
                )}
                {intake.applicant.email && (
                  <Field label="Email" value={intake.applicant.email} />
                )}
              </div>
              {(intake.applicant.addressStreet || intake.applicant.addressCity) && (
                <div className="mt-2 pt-2 border-t border-gray-100">
                  <p className="text-xs text-gray-500 font-medium uppercase mb-1">Address</p>
                  <p className="text-sm text-gray-800">
                    {intake.applicant.addressStreet && <>{intake.applicant.addressStreet}<br /></>}
                    {[intake.applicant.addressCity, intake.applicant.addressState, intake.applicant.addressZip]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                </div>
              )}
            </Section>
          )}

          {/* Household */}
          <Section title={`HOUSEHOLD COMPOSITION (SNAP Household Size: ${(intake.householdMembers?.length || 0) + 1})`}>
            {intake.applicant && (
              <p className="text-sm">
                <strong>Applicant:</strong> {intake.applicant.firstName} {intake.applicant.lastName}
                {intake.applicant.dob && `, DOB ${new Date(intake.applicant.dob).toLocaleDateString()}`}
                , Head of Household
              </p>
            )}
            {intake.householdMembers?.map((m) => (
              <div key={m.id} className="text-sm py-1">
                <p>
                  <strong>{m.firstName} {m.lastName}</strong>
                  {m.dob && `, DOB ${new Date(m.dob).toLocaleDateString()}`}
                  , {m.relationshipToApplicant}
                </p>
                <p className="text-xs text-gray-500 ml-4">
                  {m.inSnapHousehold ? "In SNAP household" : "NOT in SNAP household"}
                  {m.purchasesAndPreparesTogether !== undefined && (
                    m.purchasesAndPreparesTogether ? " | Purchases & prepares food together" : " | Does NOT purchase & prepare food together"
                  )}
                  {m.isElderly && " | Elderly"}
                  {m.isDisabled && " | Disabled"}
                  {m.hasEarnedIncome && " | Has earned income"}
                  {m.hasUnearnedIncome && " | Has unearned income"}
                </p>
              </div>
            ))}
          </Section>

          {/* Income */}
          <Section title="INCOME">
            {intake.incomeSources?.map((s) => (
              <div key={s.id} className="text-sm py-1 border-b border-gray-50 last:border-0">
                <p className="break-words">
                  <strong>
                    {s.householdMember
                      ? `${s.householdMember.firstName} ${s.householdMember.lastName}`
                      : "Applicant"}
                  </strong>
                  {" "} — {s.employerOrPayerName || s.incomeType}, {s.payFrequency.toLowerCase()} $
                  {s.grossAmountPerPeriod.toFixed(2)} {"\u2192"} SNAP monthly: ${s.snapMonthlyAmount?.toFixed(2)}
                </p>
                {s.incomeType === "SELF_EMPLOYMENT" && (
                  <div className="ml-4 mt-1 text-xs text-gray-500 space-y-0.5">
                    {s.selfEmploymentGross != null && <p>Gross self-employment: ${s.selfEmploymentGross.toFixed(2)}</p>}
                    {s.selfEmploymentExpenses != null && <p>Business expenses: ${s.selfEmploymentExpenses.toFixed(2)}</p>}
                    {s.selfEmploymentNet != null && <p>Net self-employment: ${s.selfEmploymentNet.toFixed(2)}</p>}
                    {s.selfEmploymentDeductionMethod && <p>Deduction method: {s.selfEmploymentDeductionMethod}</p>}
                  </div>
                )}
              </div>
            ))}
          </Section>

          {/* Deductions */}
          {intake.deductions?.length > 0 && (() => {
            const grossIncome = intake.incomeSources?.reduce((s, i) => s + (i.snapMonthlyAmount || 0), 0) || 0;
            const totalDeductions = intake.deductions.reduce((s, d) => s + d.amount, 0);
            const netIncome = Math.max(0, grossIncome - totalDeductions);
            return (
              <IncomeCalculationDisplay
                deductions={{
                  grossIncome,
                  netIncome,
                  totalDeductions,
                  deductions: intake.deductions.map((d) => ({
                    type: d.deductionType,
                    amount: d.amount,
                    notes: d.calculationNotes,
                  })),
                }}
              />
            );
          })()}

          {/* Shelter Expenses — full breakdown */}
          {intake.shelterExpense && (
            <Section title="SHELTER EXPENSES">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                <Field label="Rent / Mortgage" value={`$${Number(intake.shelterExpense.rentOrMortgage || 0).toFixed(2)}`} />
                {intake.shelterExpense.propertyTax != null && (
                  <Field label="Property Tax" value={`$${Number(intake.shelterExpense.propertyTax).toFixed(2)}`} />
                )}
                {intake.shelterExpense.homeownersInsurance != null && (
                  <Field label="Homeowners Insurance" value={`$${Number(intake.shelterExpense.homeownersInsurance).toFixed(2)}`} />
                )}
                <Field
                  label="Utility Type"
                  value={formatUtilityType(intake.shelterExpense.utilityType)}
                />
                {intake.shelterExpense.standardUtilityAllowance != null && (
                  <Field label="Standard Utility Allowance" value={`$${Number(intake.shelterExpense.standardUtilityAllowance).toFixed(2)}`} />
                )}
              </div>
              <div className="mt-2 pt-2 border-t border-gray-200 flex justify-between text-sm font-bold">
                <span>Total Shelter Cost</span>
                <span>${Number(intake.shelterExpense.totalShelterCost || 0).toFixed(2)}</span>
              </div>
            </Section>
          )}

          {/* Documents */}
          {intake.documentChecklist?.length > 0 && (
            <DocumentChecklist items={intake.documentChecklist} />
          )}

          {/* Conversation Log — audit trail */}
          {intake.conversationLogs?.length > 0 && (
            <ConversationLog logs={intake.conversationLogs} intakeId={intake.id} />
          )}

          {/* Review History */}
          {intake.reviews?.length > 0 && (
            <Section title={`REVIEW HISTORY (${intake.reviews.length})`}>
              {intake.reviews.map((review, i) => (
                <div key={i} className="py-2 border-b border-gray-100 last:border-0">
                  <div className="flex flex-col sm:flex-row sm:justify-between gap-1">
                    <p className="text-sm">
                      <strong>{review.caseworker?.name || "Unknown"}</strong>
                      {review.correctionsMade && (
                        <span className="ml-2 text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded-full">
                          Corrections: {review.correctionType || "General"}
                        </span>
                      )}
                      {!review.correctionsMade && (
                        <span className="ml-2 text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-full">
                          No corrections
                        </span>
                      )}
                    </p>
                    <span className="text-xs text-gray-400">
                      {review.reviewedAt ? new Date(review.reviewedAt).toLocaleString() : ""}
                    </span>
                  </div>
                  {review.notes && (
                    <p className="text-sm text-gray-600 mt-1 ml-0 sm:ml-4 italic">"{review.notes}"</p>
                  )}
                </div>
              ))}
            </Section>
          )}

          {/* Review form */}
          {intake.status === "COMPLETED" && (
            <section className="bg-white rounded-lg border border-gray-200 p-4 sm:p-6" aria-label="Review intake">
              <h2 className="font-bold text-gray-700 mb-4">MARK AS REVIEWED</h2>
              <ErrorBanner message={reviewError} onRetry={submitReview} />
              <div className="space-y-3">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reviewForm.correctionsMade}
                    onChange={(e) => setReviewForm({ ...reviewForm, correctionsMade: e.target.checked })}
                    className="rounded focus:ring-2 focus:ring-cushion-500"
                    id="corrections-checkbox"
                  />
                  <span className="text-sm">Corrections were needed</span>
                </label>

                {reviewForm.correctionsMade && (
                  <div>
                    <label htmlFor="correction-type" className="block text-sm font-medium text-gray-700 mb-1">
                      Correction Type
                    </label>
                    <select
                      id="correction-type"
                      value={reviewForm.correctionType}
                      onChange={(e) => setReviewForm({ ...reviewForm, correctionType: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cushion-500"
                    >
                      <option value="">Select correction type</option>
                      <option value="INCOME">Income</option>
                      <option value="HOUSEHOLD">Household</option>
                      <option value="DEDUCTION">Deduction</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </div>
                )}

                <div>
                  <label htmlFor="review-notes" className="block text-sm font-medium text-gray-700 mb-1">
                    Notes
                  </label>
                  <textarea
                    id="review-notes"
                    value={reviewForm.notes}
                    onChange={(e) => setReviewForm({ ...reviewForm, notes: e.target.value })}
                    placeholder="Optional notes about this review"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm h-20 focus:outline-none focus:ring-2 focus:ring-cushion-500"
                  />
                </div>

                <button
                  onClick={submitReview}
                  disabled={reviewing}
                  className="bg-green-600 text-white rounded-lg px-6 py-2 text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
                >
                  {reviewing ? "Submitting..." : "Mark as Reviewed"}
                </button>
              </div>
            </section>
          )}

          {intake.status === "REVIEWED" && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center" role="status">
              <p className="text-green-800 font-medium">
                <span aria-hidden="true">{"\u2713"} </span>
                This intake has been reviewed
              </p>
            </div>
          )}
        </main>
      </div>
    </>
  );
}

function Section({ title, children }) {
  return (
    <section className="bg-white rounded-lg border border-gray-200 p-4" aria-label={title}>
      <h2 className="font-bold text-gray-700 mb-2">{title}</h2>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Field({ label, value }) {
  return (
    <div className="flex justify-between text-sm py-0.5">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-800 text-right">{value}</span>
    </div>
  );
}

function formatCitizenship(status) {
  const labels = {
    US_CITIZEN: "U.S. Citizen",
    PERMANENT_RESIDENT: "Permanent Resident",
    QUALIFIED_ALIEN: "Qualified Alien",
    REFUGEE: "Refugee / Asylee",
    OTHER: "Other",
  };
  return labels[status] || status?.replace(/_/g, " ") || "Unknown";
}

function formatUtilityType(type) {
  const labels = {
    HEATING_COOLING: "Heating & Cooling",
    BASIC: "Basic Utilities",
    PHONE_ONLY: "Phone Only",
    NONE: "None",
  };
  return labels[type] || type?.replace(/_/g, " ") || "Unknown";
}

function ConversationLog({ logs, intakeId }) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...logs].sort((a, b) => a.turnNumber - b.turnNumber);
  const displayed = expanded ? sorted : sorted.slice(0, 6);

  const handlePrint = () => {
    const content = sorted
      .map((l) => `[${new Date(l.timestamp).toLocaleString()}] ${l.role}: ${l.content}`)
      .join("\n\n");
    const win = window.open("", "_blank");
    win.document.write(
      `<html><head><title>Conversation Log — Intake #${intakeId.slice(0, 8).toUpperCase()}</title>` +
      `<style>body{font-family:monospace;white-space:pre-wrap;padding:2rem;font-size:12px;line-height:1.6}` +
      `h1{font-size:16px;margin-bottom:1rem}</style></head><body>` +
      `<h1>Conversation Log — Intake #${intakeId.slice(0, 8).toUpperCase()}</h1>` +
      `<p>Generated: ${new Date().toLocaleString()}</p><hr/>\n${content.replace(/</g, "&lt;").replace(/>/g, "&gt;")}` +
      `</body></html>`
    );
    win.document.close();
    win.print();
  };

  return (
    <section className="bg-white rounded-lg border border-gray-200 p-4" aria-label="Conversation log">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-3 gap-2">
        <h2 className="font-bold text-gray-700">CONVERSATION LOG ({sorted.length} messages)</h2>
        <button
          onClick={handlePrint}
          className="text-xs text-cushion-600 hover:text-cushion-800 border border-cushion-300 rounded px-3 py-1 hover:bg-cushion-50 transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500 self-start"
          aria-label="Print conversation log for audit file"
        >
          Print for Audit File
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Full AI-assisted intake transcript. Retained for audit and compliance purposes.
      </p>
      <div className="space-y-3 max-h-96 overflow-y-auto chat-scroll" role="log" aria-label="Conversation transcript">
        {displayed.map((log) => (
          <div key={log.turnNumber} className={`flex ${log.role === "USER" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 ${
                log.role === "USER"
                  ? "bg-cushion-50 border border-cushion-200"
                  : log.role === "SYSTEM"
                  ? "bg-gray-200 border border-gray-300 italic"
                  : "bg-gray-50 border border-gray-200"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-gray-500">
                  {log.role === "USER" ? "Applicant" : log.role === "SYSTEM" ? "System" : "AI Assistant"}
                </span>
                <span className="text-xs text-gray-400 ml-3">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{log.content}</p>
            </div>
          </div>
        ))}
      </div>
      {sorted.length > 6 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-3 text-sm text-cushion-600 hover:text-cushion-800 underline focus:outline-none focus:ring-2 focus:ring-cushion-500 rounded"
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : `Show all ${sorted.length} messages`}
        </button>
      )}
    </section>
  );
}
