import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";

const RISK_COLORS = {
  LOW: { bg: "bg-green-100", text: "text-green-800", dot: "bg-green-500", label: "GREEN" },
  MEDIUM: { bg: "bg-yellow-100", text: "text-yellow-800", dot: "bg-yellow-500", label: "YELLOW" },
  HIGH: { bg: "bg-red-100", text: "text-red-800", dot: "bg-red-500", label: "RED" },
};

const DEDUCTION_LABELS = {
  STANDARD: "Standard deduction",
  EARNED_INCOME_20PCT: "Earned income (20%)",
  DEPENDENT_CARE: "Dependent care",
  MEDICAL: "Medical (elderly/disabled)",
  CHILD_SUPPORT_PAID: "Child support paid",
  SHELTER_EXCESS: "Excess shelter",
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

  const handlePrint = () => window.print();

  if (loading) return <div className="p-8 text-center text-gray-500">Loading...</div>;
  if (!intake) return <div className="p-8 text-center text-red-500">Intake not found</div>;

  const flags = intake.consistencyFlags || [];
  const risk = RISK_COLORS[intake.riskScore] || RISK_COLORS.LOW;
  const eligibility = intake.eligibility;
  const auditTrail = intake.auditTrail;
  const snapHouseholdSize = (intake.householdMembers?.filter((m) => m.inSnapHousehold).length || 0) + 1;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 print:border-0">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <button onClick={() => navigate("/caseworker/dashboard")} className="text-cushion-600 hover:text-cushion-800 text-sm print:hidden">
              {"\u2190"} Dashboard
            </button>
            <div>
              <h1 className="text-xl font-bold text-gray-900 tracking-wide">
                CUSHION INTAKE SUMMARY
              </h1>
              <p className="text-sm text-gray-500">
                Intake #CU-{new Date(intake.createdAt).toISOString().slice(0, 10).replace(/-/g, "")}-{intake.id.slice(0, 4).toUpperCase()}
                {" | "}Completed: {new Date(intake.updatedAt).toLocaleString()}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-3 print:hidden">
            <button onClick={handlePrint} className="border border-gray-300 text-gray-600 text-sm px-3 py-1.5 rounded hover:bg-gray-50 transition-colors">
              Print
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto p-6 space-y-5">
        {/* Risk Score + Expedited status bar */}
        <div className="flex items-center justify-between bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <span className="text-sm font-bold text-gray-600 uppercase">Risk Score:</span>
              <span className={`inline-flex items-center space-x-1.5 px-3 py-1 rounded-full ${risk.bg}`}>
                <span className={`w-2.5 h-2.5 rounded-full ${risk.dot}`} />
                <span className={`text-sm font-bold ${risk.text}`}>{risk.label}</span>
              </span>
            </div>
          </div>
          <div>
            {intake.expeditedFlag ? (
              <span className="bg-red-600 text-white text-sm px-4 py-1.5 rounded font-bold">
                EXPEDITED &mdash; 7-day processing
              </span>
            ) : (
              <span className="text-sm text-gray-500">Standard processing</span>
            )}
          </div>
        </div>

        {/* Expedited reason */}
        {intake.expeditedFlag && intake.expeditedReason && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-800 font-bold text-sm">EXPEDITED: YES</p>
            <p className="text-red-700 text-sm mt-1">{intake.expeditedReason}</p>
          </div>
        )}

        {/* Flags */}
        {flags.length > 0 && (
          <Section title={`FLAGS (${flags.length})`}>
            <div className="space-y-2">
              {flags.map((flag, i) => (
                <div key={i} className={`flex items-start space-x-2 rounded-lg p-3 ${
                  flag.severity === "HIGH" ? "bg-red-50 border border-red-200" :
                  flag.severity === "MEDIUM" ? "bg-yellow-50 border border-yellow-200" :
                  "bg-blue-50 border border-blue-200"
                }`}>
                  <span className="mt-0.5 text-sm">
                    {flag.severity === "HIGH" ? "\u26A0\uFE0F" : flag.severity === "MEDIUM" ? "\u26A0\uFE0F" : "\u2139\uFE0F"}
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-800">
                      {flag.severity}: {flag.message}
                    </p>
                    {flag.suggestedAction && (
                      <p className="text-xs text-gray-600 mt-0.5">Action: {flag.suggestedAction}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Household Composition */}
        <Section title={`HOUSEHOLD COMPOSITION (SNAP Household Size: ${snapHouseholdSize})`}>
          {intake.applicant && (
            <div className="text-sm py-1">
              <span className="font-medium">Applicant:</span>{" "}
              {intake.applicant.firstName} {intake.applicant.lastName}
              {intake.applicant.dob && `, DOB ${formatDate(intake.applicant.dob)}`}
              , Head of Household
            </div>
          )}
          {intake.householdMembers?.map((m) => (
            <div key={m.id} className="text-sm py-1">
              {m.firstName} {m.lastName}
              {m.dob && `, DOB ${formatDate(m.dob)}`}
              , {m.relationshipToApplicant}
              {m.inSnapHousehold ? " \u2014 in SNAP household" : " \u2014 NOT in SNAP household"}
              {m.isElderly && ` (elderly${m.dob ? `, age ${calculateAge(m.dob)}` : ""})`}
              {m.isDisabled && " (disabled)"}
            </div>
          ))}
        </Section>

        {/* Income */}
        <Section title="INCOME">
          {intake.incomeSources?.length > 0 ? (
            <>
              {intake.incomeSources.map((s) => (
                <div key={s.id} className="text-sm py-1">
                  <span className="font-medium">
                    {s.householdMember
                      ? `${s.householdMember.firstName} ${s.householdMember.lastName}`
                      : intake.applicant ? `${intake.applicant.firstName} ${intake.applicant.lastName}` : "Applicant"}
                  </span>
                  {" \u2014 "}
                  {s.employerOrPayerName || formatIncomeType(s.incomeType)}
                  {s.employerOrPayerName && ` (${formatIncomeType(s.incomeType)})`}
                  , {s.payFrequency.toLowerCase()} ${fmtCurrency(s.grossAmountPerPeriod)}
                  {" \u2192 SNAP monthly: "}
                  <span className="font-medium">${fmtCurrency(s.snapMonthlyAmount)}</span>
                </div>
              ))}
              {eligibility && (
                <div className="border-t border-gray-200 mt-2 pt-2 text-sm font-bold">
                  Total Gross Monthly Income: ${fmtCurrency(eligibility.deductions?.grossIncome)}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-500">No income sources reported</p>
          )}
        </Section>

        {/* Deduction Calculation */}
        {eligibility?.deductions && (
          <Section title="DEDUCTION CALCULATION">
            <div className="space-y-1 text-sm">
              {eligibility.deductions.deductions.map((d, i) => (
                <div key={i} className="flex justify-between py-0.5">
                  <span className="text-gray-700">{d.notes || DEDUCTION_LABELS[d.type] || d.type}</span>
                </div>
              ))}
              <div className="border-t border-gray-200 mt-2 pt-2 flex justify-between font-medium">
                <span>Total Deductions</span>
                <span>${fmtCurrency(eligibility.deductions.totalDeductions)}</span>
              </div>
              <div className="flex justify-between font-bold bg-gray-50 px-2 py-1 rounded">
                <span>Net Monthly Income</span>
                <span>${fmtCurrency(eligibility.deductions.netIncome)}</span>
              </div>
            </div>
          </Section>
        )}

        {/* Eligibility Estimate */}
        {eligibility && (
          <Section title="ELIGIBILITY ESTIMATE">
            <div className="space-y-2 text-sm">
              {/* Gross income test */}
              <div className={`rounded-lg p-3 ${eligibility.grossIncomeTest.passes ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
                <p className={`font-medium ${eligibility.grossIncomeTest.passes ? "text-green-800" : "text-red-800"}`}>
                  Gross income test ({eligibility.grossIncomeTest.bbcePercent || 130}% FPL for {eligibility.deductions.householdSize}):
                  {" "}
                  {eligibility.grossIncomeTest.skipped
                    ? "SKIPPED \u2014 elderly/disabled household"
                    : `$${fmtCurrency(eligibility.grossIncomeTest.grossIncome)} ${eligibility.grossIncomeTest.passes ? "\u2264" : ">"} $${eligibility.grossIncomeTest.limit}`}
                  {" \u2014 "}
                  {eligibility.grossIncomeTest.passes ? "PASSES" : "DOES NOT PASS"}
                </p>
                {eligibility.grossIncomeTest.skipped && (
                  <p className="text-green-700 text-xs mt-1">{eligibility.grossIncomeTest.reason}</p>
                )}
              </div>

              {/* Net income test */}
              <div className={`rounded-lg p-3 ${eligibility.netIncomeTest.passes ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
                <p className={`font-medium ${eligibility.netIncomeTest.passes ? "text-green-800" : "text-red-800"}`}>
                  Net income test (100% FPL for {eligibility.deductions.householdSize}):
                  {" "}
                  ${fmtCurrency(eligibility.netIncomeTest.netIncome)} {eligibility.netIncomeTest.passes ? "\u2264" : ">"} ${eligibility.netIncomeTest.limit}
                  {" \u2014 "}
                  {eligibility.netIncomeTest.passes ? "PASSES" : "DOES NOT PASS"}
                </p>
                {!eligibility.netIncomeTest.passes && (
                  <p className="text-red-700 text-xs mt-1">
                    Net income exceeds limit by ${fmtCurrency(eligibility.netIncomeTest.netIncome - eligibility.netIncomeTest.limit)} &mdash; verify all deductions and income figures
                  </p>
                )}
              </div>

              {/* Benefit estimate */}
              <div className={`rounded-lg p-3 ${eligibility.eligible ? "bg-green-50 border border-green-200" : "bg-gray-50 border border-gray-200"}`}>
                <div className="flex justify-between items-center">
                  <span className="font-bold text-gray-800">Estimated Monthly Benefit</span>
                  <span className={`text-lg font-bold ${eligibility.eligible ? "text-green-700" : "text-gray-500"}`}>
                    {eligibility.eligible
                      ? `$${eligibility.benefitEstimate.estimatedBenefit}`
                      : "Ineligible"}
                  </span>
                </div>
                {eligibility.eligible && (
                  <p className="text-xs text-gray-500 mt-1">
                    Max allotment (${eligibility.benefitEstimate.maxAllotment}) - 30% of net income (${eligibility.benefitEstimate.expectedContribution})
                  </p>
                )}
              </div>
            </div>
          </Section>
        )}

        {/* Document Checklist */}
        {intake.documentChecklist?.length > 0 && (
          <Section title="DOCUMENT CHECKLIST">
            <div className="space-y-1.5">
              {intake.documentChecklist.map((doc, i) => (
                <div key={i} className="flex items-start space-x-2 text-sm">
                  <span className={`mt-0.5 ${doc.required ? "text-gray-800" : "text-gray-400"}`}>
                    {doc.applicantConfirmedHas ? "\u2611" : "\u2610"}
                  </span>
                  <div>
                    <span className="text-gray-800">{doc.documentType}</span>
                    {doc.description && (
                      <span className="text-gray-500"> &mdash; {doc.description}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Audit Trail */}
        {auditTrail && (
          <Section title="AUDIT TRAIL">
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
              <div className="text-gray-600">Intake started:</div>
              <div className="text-gray-800">{new Date(auditTrail.intakeStarted).toLocaleString()}</div>

              <div className="text-gray-600">Intake completed:</div>
              <div className="text-gray-800">{new Date(auditTrail.intakeCompleted).toLocaleString()}</div>

              <div className="text-gray-600">Duration:</div>
              <div className="text-gray-800">{auditTrail.durationMinutes} minutes</div>

              <div className="text-gray-600">Questions asked:</div>
              <div className="text-gray-800">{auditTrail.questionsAsked}</div>

              <div className="text-gray-600">Flags generated:</div>
              <div className="text-gray-800">{auditTrail.flagsGenerated}</div>

              <div className="text-gray-600">Applicant confirmed summary:</div>
              <div className="text-gray-800">{auditTrail.applicantConfirmedSummary ? "Yes" : "No"}</div>
            </div>
          </Section>
        )}

        {/* Review History */}
        {intake.reviews?.length > 0 && (
          <Section title="REVIEW HISTORY">
            {intake.reviews.map((r, i) => (
              <div key={i} className="text-sm py-1 border-b border-gray-100 last:border-0">
                <span className="font-medium">{r.caseworker?.name || "Caseworker"}</span>
                {" \u2014 "}{new Date(r.reviewedAt).toLocaleString()}
                {r.correctionsMade && (
                  <span className="ml-2 text-orange-600 font-medium">
                    Correction: {r.correctionType}
                  </span>
                )}
                {r.notes && <p className="text-gray-500 mt-0.5">{r.notes}</p>}
              </div>
            ))}
          </Section>
        )}

        {/* Review form */}
        {intake.status === "COMPLETED" && (
          <div className="bg-white rounded-lg border border-gray-200 p-6 print:hidden">
            <h2 className="font-bold text-gray-700 mb-4">MARK AS REVIEWED</h2>
            <div className="space-y-3">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={reviewForm.correctionsMade}
                  onChange={(e) => setReviewForm({ ...reviewForm, correctionsMade: e.target.checked })}
                  className="rounded"
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

        {intake.status === "REVIEWED" && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center print:hidden">
            <p className="text-green-800 font-medium">{"\u2713"} This intake has been reviewed</p>
          </div>
        )}
      </div>
    </>
  );
}

function Section({ title, children }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h2 className="font-bold text-gray-700 mb-3 text-sm uppercase tracking-wide">{title}</h2>
      <div>{children}</div>
    </div>
  );
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
}

function calculateAge(dob) {
  const birth = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const monthDiff = now.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

function fmtCurrency(val) {
  if (val == null) return "0.00";
  return Number(val).toFixed(2);
}

function formatIncomeType(type) {
  const labels = {
    EMPLOYMENT: "Wages/Salary",
    SELF_EMPLOYMENT: "Self-Employment",
    SSI: "SSI",
    SSDI: "SSDI",
    SOCIAL_SECURITY: "Social Security",
    UNEMPLOYMENT: "Unemployment",
    CHILD_SUPPORT_RECEIVED: "Child Support",
    VA_BENEFITS: "VA Benefits",
    PENSION: "Pension",
    OTHER: "Other",
  };
  return labels[type] || type;
}
