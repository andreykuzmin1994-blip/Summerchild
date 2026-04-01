export default function DocumentChecklist({ items }) {
  if (!items || items.length === 0) return null;

  return (
    <section className="border border-gray-200 rounded-lg p-4" aria-label="Document checklist">
      <h3 className="font-semibold text-gray-700 mb-3">Documents to Bring</h3>
      <p className="text-xs text-gray-500 mb-3">
        Please bring the following documents to your interview:
      </p>
      <ul className="space-y-2" role="list">
        {items.map((item, i) => (
          <li key={i} className="flex items-start space-x-2">
            <span
              className={`mt-0.5 ${item.required ? "text-red-500" : "text-gray-400"}`}
              aria-hidden="true"
            >
              {item.applicantConfirmedHas ? "\u2611" : "\u2610"}
            </span>
            <div>
              <span className="text-sm text-gray-800">
                {item.documentType}
                <span className="sr-only">
                  {item.applicantConfirmedHas ? " - applicant confirmed" : " - not yet confirmed"}
                </span>
              </span>
              {item.description && (
                <p className="text-xs text-gray-500">{item.description}</p>
              )}
              {item.required && (
                <span className="text-xs text-red-500 font-medium" aria-label="This document is required">Required</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
