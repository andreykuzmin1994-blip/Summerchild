export default function ReviewSummary({ summary, onConfirm, onEdit }) {
  if (!summary) return null;

  const { intake, eligibility, consistency } = summary;

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <h2 className="text-xl font-bold text-gray-800">Review Your Information</h2>
      <p className="text-sm text-gray-600">
        Please review the information below. If everything is correct, confirm to complete your intake.
      </p>

      {/* Applicant Info */}
      {intake?.applicant && (
        <Section title="Your Information">
          <Field label="Name" value={`${intake.applicant.firstName} ${intake.applicant.lastName}`} />
          {intake.applicant.addressCity && (
            <Field label="City" value={`${intake.applicant.addressCity}, ${intake.applicant.addressState}`} />
          )}
          {intake.applicant.phone && <Field label="Phone" value={intake.applicant.phone} />}
        </Section>
      )}

      {/* Household */}
      {intake?.householdMembers?.length > 0 && (
        <Section title={`Household Members (${intake.householdMembers.length})`}>
          {intake.householdMembers.map((m) => (
            <div key={m.id} className="py-1">
              <span className="font-medium">{m.firstName} {m.lastName}</span>
              <span className="text-gray-500 text-sm ml-2">
                ({m.relationshipToApplicant}
                {m.isElderly && ", elderly"}
                {m.isDisabled && ", disabled"})
              </span>
            </div>
          ))}
        </Section>
      )}

      {/* Income */}
      {intake?.incomeSources?.length > 0 && (
        <Section title="Income Sources">
          {intake.incomeSources.map((s) => (
            <div key={s.id} className="py-1 flex justify-between">
              <span>
                {s.employerOrPayerName || s.incomeType}
                <span className="text-gray-500 text-sm ml-1">({s.payFrequency.toLowerCase()})</span>
              </span>
              <span className="font-medium">${s.snapMonthlyAmount?.toFixed(2)}/mo</span>
            </div>
          ))}
          {eligibility && (
            <div className="border-t mt-2 pt-2 flex justify-between font-bold">
              <span>Total Gross Monthly</span>
              <span>${eligibility.deductions?.grossIncome?.toFixed(2)}</span>
            </div>
          )}
        </Section>
      )}

      {/* Shelter */}
      {intake?.shelterExpense && (
        <Section title="Shelter Expenses">
          <Field label="Rent/Mortgage" value={`$${intake.shelterExpense.rentOrMortgage}`} />
          <Field label="Utility Type" value={intake.shelterExpense.utilityType?.replace("_", " ")} />
          <Field label="Total Shelter" value={`$${intake.shelterExpense.totalShelterCost}`} />
        </Section>
      )}

      {/* Benefit Estimate */}
      {eligibility?.benefitEstimate && (
        <div className="bg-cushion-50 rounded-lg p-4 border border-cushion-100">
          <h3 className="font-bold text-cushion-800">Estimated Monthly Benefit</h3>
          <p className="text-3xl font-bold text-cushion-700 mt-1">
            ${eligibility.benefitEstimate.estimatedBenefit}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            This is an estimate. Your caseworker will make the final determination.
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex space-x-3 pt-4">
        <button
          onClick={onConfirm}
          className="flex-1 bg-green-600 text-white rounded-lg py-3 font-medium hover:bg-green-700 transition-colors"
        >
          I confirm this information is accurate
        </button>
        <button
          onClick={onEdit}
          className="flex-1 border border-gray-300 text-gray-700 rounded-lg py-3 font-medium hover:bg-gray-50 transition-colors"
        >
          I need to make a correction
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <h3 className="font-semibold text-gray-700 mb-2">{title}</h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-800">{value}</span>
    </div>
  );
}
