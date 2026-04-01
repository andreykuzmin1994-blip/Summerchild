import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import IncomeCalculationDisplay from "../components/IncomeCalculationDisplay";
import DocumentChecklist from "../components/DocumentChecklist";

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

  const token = localStorage.getItem("token");

  useEffect(() => {
    if (!token) { navigate("/login"); return; }
    loadIntake();
  }, [id]);

  const loadIntake = async () => {
    try {
      const res = await fetch(`/api/caseworker/intake/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { navigate("/login"); return; }
      const data = await res.json();
      setIntake(data);
    } catch (error) {
      console.error("Failed to load intake:", error);
    }
    setLoading(false);
  };

  const submitReview = async () => {
    setReviewing(true);
    try {
      await fetch(`/api/caseworker/intake/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(reviewForm),
      });
      loadIntake();
    } catch (error) {
      console.error("Failed to submit review:", error);
    }
    setReviewing(false);
  };

  if (loading) return <div className="p-8 text-center text-gray-500">Loading...</div>;
  if (!intake) return <div className="p-8 text-center text-red-500">Intake not found</div>;

  const flags = intake.consistencyFlags || [];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <button onClick={() => navigate("/caseworker/dashboard")} className="text-cushion-600 hover:text-cushion-800 text-sm">
            {"\u2190"} Dashboard
          </button>
          <div>
            <h1 className="text-lg font-bold text-gray-800">
              CUSHION INTAKE SUMMARY
            </h1>
            <p className="text-xs text-gray-500">
              Intake #{intake.id.slice(0, 8).toUpperCase()} | {new Date(intake.createdAt).toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-3">
          {intake.expeditedFlag && (
            <span className="bg-red-500 text-white text-sm px-3 py-1 rounded font-bold">EXPEDITED</span>
          )}
          {intake.riskScore && (
            <div className="flex items-center space-x-1">
              <span className={`w-3 h-3 rounded-full ${RISK_COLORS[intake.riskScore]}`} />
              <span className="text-sm font-medium">{intake.riskScore} RISK</span>
            </div>
          )}
        </div>
      </header>

      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Expedited banner */}
        {intake.expeditedFlag && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-800 font-bold">EXPEDITED: 7-day processing required</p>
            <p className="text-red-600 text-sm">{intake.expeditedReason}</p>
          </div>
        )}

        {/* Flags */}
        {flags.length > 0 && (
          <div className="space-y-2">
            <h2 className="font-bold text-gray-700">FLAGS ({flags.length})</h2>
            {flags.map((flag, i) => (
              <div key={i} className={`rounded-lg p-3 ${
                flag.severity === "HIGH" ? "bg-red-50 border border-red-200" :
                flag.severity === "MEDIUM" ? "bg-yellow-50 border border-yellow-200" :
                "bg-blue-50 border border-blue-200"
              }`}>
                <p className="text-sm font-medium">
                  {flag.severity === "HIGH" ? "\u26A0\uFE0F" : flag.severity === "MEDIUM" ? "\u26A0\uFE0F" : "\u2139\uFE0F"}{" "}
                  {flag.severity}: {flag.message}
                </p>
                {flag.suggestedAction && (
                  <p className="text-xs text-gray-600 mt-1">Action: {flag.suggestedAction}</p>
                )}
              </div>
            ))}
          </div>
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
            <p key={m.id} className="text-sm">
              {m.firstName} {m.lastName}
              {m.dob && `, DOB ${new Date(m.dob).toLocaleDateString()}`}
              , {m.relationshipToApplicant}
              {m.inSnapHousehold ? " — in SNAP household" : " — NOT in SNAP household"}
              {m.isElderly && " (elderly)"}
              {m.isDisabled && " (disabled)"}
            </p>
          ))}
        </Section>

        {/* Income */}
        <Section title="INCOME">
          {intake.incomeSources?.map((s) => (
            <p key={s.id} className="text-sm">
              {s.householdMember
                ? `${s.householdMember.firstName} ${s.householdMember.lastName}`
                : "Applicant"}{" "}
              — {s.employerOrPayerName || s.incomeType}, {s.payFrequency.toLowerCase()} $
              {s.grossAmountPerPeriod.toFixed(2)} {"\u2192"} SNAP monthly: ${s.snapMonthlyAmount?.toFixed(2)}
            </p>
          ))}
        </Section>

        {/* Deductions */}
        {intake.deductions?.length > 0 && (
          <IncomeCalculationDisplay
            deductions={{
              grossIncome: intake.incomeSources?.reduce((s, i) => s + (i.snapMonthlyAmount || 0), 0),
              netIncome: 0, // Would need recalculation
              totalDeductions: intake.deductions.reduce((s, d) => s + d.amount, 0),
              deductions: intake.deductions.map((d) => ({
                type: d.deductionType,
                amount: d.amount,
                notes: d.calculationNotes,
              })),
            }}
          />
        )}

        {/* Documents */}
        {intake.documentChecklist?.length > 0 && (
          <DocumentChecklist items={intake.documentChecklist} />
        )}

        {/* Review form */}
        {intake.status === "COMPLETED" && (
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h2 className="font-bold text-gray-700 mb-4">MARK AS REVIEWED</h2>
            <div className="space-y-3">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={reviewForm.correctionsMade}
                  onChange={(e) => setReviewForm({ ...reviewForm, correctionsMade: e.target.checked })}
                  className="rounded"
                />
                <span className="text-sm">Corrections were needed</span>
              </label>

              {reviewForm.correctionsMade && (
                <select
                  value={reviewForm.correctionType}
                  onChange={(e) => setReviewForm({ ...reviewForm, correctionType: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="">Select correction type</option>
                  <option value="INCOME">Income</option>
                  <option value="HOUSEHOLD">Household</option>
                  <option value="DEDUCTION">Deduction</option>
                  <option value="OTHER">Other</option>
                </select>
              )}

              <textarea
                value={reviewForm.notes}
                onChange={(e) => setReviewForm({ ...reviewForm, notes: e.target.value })}
                placeholder="Notes (optional)"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm h-20"
              />

              <button
                onClick={submitReview}
                disabled={reviewing}
                className="bg-green-600 text-white rounded-lg px-6 py-2 text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                {reviewing ? "Submitting..." : "Mark as Reviewed"}
              </button>
            </div>
          </div>
        )}

        {intake.status === "REVIEWED" && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
            <p className="text-green-800 font-medium">{"\u2713"} This intake has been reviewed</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h2 className="font-bold text-gray-700 mb-2">{title}</h2>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
