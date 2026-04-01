const SECTIONS = [
  { key: "WELCOME", label: "Welcome" },
  { key: "HOUSEHOLD", label: "Household" },
  { key: "INCOME", label: "Income" },
  { key: "EXPENSES", label: "Expenses" },
  { key: "REVIEW", label: "Review" },
];

export default function ProgressBar({ currentSection }) {
  const currentIndex = SECTIONS.findIndex((s) => s.key === currentSection);

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
      {SECTIONS.map((section, i) => {
        const isActive = i === currentIndex;
        const isComplete = i < currentIndex;

        return (
          <div key={section.key} className="flex items-center flex-1">
            <div className="flex flex-col items-center flex-1">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ${
                  isComplete
                    ? "bg-green-500 text-white"
                    : isActive
                    ? "bg-cushion-600 text-white"
                    : "bg-gray-200 text-gray-500"
                }`}
              >
                {isComplete ? "\u2713" : i + 1}
              </div>
              <span
                className={`text-xs mt-1 ${
                  isActive ? "text-cushion-700 font-medium" : "text-gray-500"
                }`}
              >
                {section.label}
              </span>
            </div>
            {i < SECTIONS.length - 1 && (
              <div
                className={`h-0.5 flex-1 mx-1 ${
                  i < currentIndex ? "bg-green-500" : "bg-gray-200"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
