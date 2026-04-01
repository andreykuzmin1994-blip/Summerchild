export default function IncomeCalculationDisplay({ deductions }) {
  if (!deductions) return null;

  return (
    <section className="border border-gray-200 rounded-lg p-4" aria-label="SNAP income calculation">
      <h3 className="font-semibold text-gray-700 mb-3">SNAP Income Calculation</h3>

      <div className="space-y-2 text-sm">
        <Row label="Gross Monthly Income" value={deductions.grossIncome} bold />

        <div className="border-t border-gray-100 pt-2 mt-2">
          <p className="text-xs text-gray-500 font-medium uppercase mb-1">Deductions</p>
          {deductions.deductions?.map((d, i) => (
            <Row
              key={i}
              label={formatDeductionType(d.type)}
              value={d.amount}
              prefix="-"
              note={d.notes}
            />
          ))}
        </div>

        <div className="border-t border-gray-200 pt-2 mt-2">
          <Row label="Total Deductions" value={deductions.totalDeductions} bold prefix="-" />
          <Row label="Net Monthly Income" value={deductions.netIncome} bold highlight />
        </div>
      </div>
    </section>
  );
}

function Row({ label, value, bold, prefix, highlight, note }) {
  const formattedValue = `${prefix || ""}$${typeof value === "number" ? value.toFixed(2) : value}`;
  return (
    <div className={`flex justify-between py-0.5 ${highlight ? "bg-yellow-50 px-2 rounded" : ""}`}>
      <div className="flex-1">
        <span className={bold ? "font-medium text-gray-800" : "text-gray-600"}>{label}</span>
        {note && <p className="text-xs text-gray-600">{note}</p>}
      </div>
      <span className={bold ? "font-bold text-gray-800" : "text-gray-700"} aria-label={`${label}: ${formattedValue}`}>
        {formattedValue}
      </span>
    </div>
  );
}

function formatDeductionType(type) {
  const labels = {
    STANDARD: "Standard deduction",
    EARNED_INCOME_20PCT: "Earned income (20%)",
    DEPENDENT_CARE: "Dependent care",
    MEDICAL: "Medical (elderly/disabled)",
    CHILD_SUPPORT_PAID: "Child support paid",
    SHELTER_EXCESS: "Excess shelter",
  };
  return labels[type] || type;
}
