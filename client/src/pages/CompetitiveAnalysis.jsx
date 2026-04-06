import { Link } from "react-router-dom";
import SkipLink from "../components/SkipLink";

const competitors = [
  {
    name: "Cushion Gov",
    type: "Us",
    highlight: true,
    founded: "2025",
    structure: "Private startup",
    headcount: "Small team",
    focus: "AI-powered SNAP intake & eligibility calculation",
    approach: "Conversational AI kiosk for county lobbies",
    target: "County DFCS offices (Georgia pilot)",
    deployment: "SaaS / on-prem per county",
    aiCapability: "Core — Claude-powered conversational intake, auto-calculation, anomaly detection",
    snapDepth: "Deep — GA state rules, deductions, expedited eligibility, overpayment detection",
    piiHandling: "Zero PII storage; PII stripper catches accidental input",
    pricing: "Per-county licensing (lightweight procurement)",
    strengths: [
      "AI-first automation reduces caseworker burden",
      "Zero-PII architecture simplifies compliance",
      "Fast county-level deployment, no massive engagement needed",
      "Purpose-built for SNAP with deep eligibility logic",
      "Kiosk-first UX designed for applicants",
    ],
    weaknesses: [
      "Early-stage, limited track record",
      "Single-program focus (SNAP only today)",
      "No federal contracts or state-level relationships yet",
      "Small team limits concurrent deployments",
    ],
  },
  {
    name: "Nava PBC",
    type: "Primary Competitor",
    highlight: false,
    founded: "2013",
    structure: "Public Benefit Corporation",
    headcount: "600+",
    focus: "Government digital services modernization & benefits delivery",
    approach: "Human-centered design consulting + open-source products",
    target: "Federal & state agencies (CMS, HHS, VA, state govs)",
    deployment: "Consulting engagements + Beam SaaS + Strata open-source",
    aiCapability: "Emerging — VA AI-enabled solutions; no conversational intake product yet",
    snapDepth: "Moderate — PA SNAP eligibility work; Beam is generic benefits platform",
    piiHandling: "Standard government compliance (FedRAMP, etc.)",
    pricing: "Large consulting contracts ($M+); Beam SaaS pricing TBD",
    strengths: [
      "HealthCare.gov rescue credibility",
      "600+ staff, proven at scale (50M+ households)",
      "End-to-end stack with Beam acquisition (Feb 2026)",
      "Existing federal/state contracts and relationships",
      "Open-source philosophy reduces vendor lock-in concerns",
    ],
    weaknesses: [
      "Consulting-heavy model = expensive and slow",
      "Beam is new (acquired Feb 2026), unproven at scale",
      "Generic benefits platform, not SNAP-specific",
      "Top-down sales cycle doesn't reach county-level buyers",
      "AI capabilities lag behind purpose-built tools",
    ],
  },
  {
    name: "Code for America",
    type: "Adjacent",
    highlight: false,
    founded: "2009",
    structure: "501(c)(3) Nonprofit",
    headcount: "200+",
    focus: "Safety net program access & government simplification",
    approach: "Direct-to-applicant tools + government partnerships",
    target: "State agencies + direct to public",
    deployment: "GetCalFresh (CA), integrated state tools",
    aiCapability: "Limited — form simplification, not conversational AI",
    snapDepth: "Moderate — GetCalFresh is SNAP-specific but CA-only; advocacy-focused",
    piiHandling: "Collects PII for application submission",
    pricing: "Grant-funded; free to applicants and often to governments",
    strengths: [
      "Strong brand in civic tech community",
      "GetCalFresh proven model for SNAP access",
      "Deep policy expertise and advocacy network",
      "Free/grant-funded removes procurement friction",
    ],
    weaknesses: [
      "Nonprofit model limits scale and speed",
      "Not a caseworker tool — applicant-facing only",
      "No AI-driven intake or eligibility calculation",
      "State-by-state approach is slow to expand",
    ],
  },
  {
    name: "Deloitte / Accenture",
    type: "Incumbent",
    highlight: false,
    founded: "Various",
    structure: "Public corporations",
    headcount: "100,000+",
    focus: "Large-scale government IT modernization",
    approach: "Waterfall/hybrid consulting + custom builds",
    target: "State & federal agencies (large contracts)",
    deployment: "Custom on-prem / cloud builds per engagement",
    aiCapability: "Broad AI practice but not benefits-specific; generic chatbots",
    snapDepth: "Project-dependent — built legacy systems many states still use",
    piiHandling: "Standard enterprise compliance",
    pricing: "Very large contracts ($10M-$100M+)",
    strengths: [
      "Massive scale and resources",
      "Existing state contracts and relationships",
      "Full-service delivery (strategy to operations)",
      "Trusted brand in government procurement",
    ],
    weaknesses: [
      "Slow, expensive, often over-budget",
      "Built many of the legacy systems that need replacing",
      "Innovation happens at edges, not core",
      "County-level deals too small to pursue",
    ],
  },
  {
    name: "Propel (Providers)",
    type: "Adjacent",
    highlight: false,
    founded: "2014",
    structure: "Private (VC-backed)",
    headcount: "~100",
    focus: "EBT balance & benefits management for recipients",
    approach: "Consumer mobile app for benefits holders",
    target: "Direct to SNAP/EBT recipients",
    deployment: "Mobile app (iOS/Android)",
    aiCapability: "Limited — notifications and balance tracking, not intake",
    snapDepth: "Post-enrollment only — EBT balance, spending, offers",
    piiHandling: "Collects user PII for account creation",
    pricing: "Free to users; ad/partnership revenue",
    strengths: [
      "5M+ users, strong consumer brand",
      "Deep understanding of benefits recipients",
      "Revenue model proven (ads, financial products)",
    ],
    weaknesses: [
      "Post-enrollment only — no intake or eligibility",
      "Not a government tool — no caseworker workflow",
      "Different part of the benefits lifecycle",
      "No government procurement experience",
    ],
  },
];

const dimensionRows = [
  { label: "Founded", key: "founded" },
  { label: "Structure", key: "structure" },
  { label: "Headcount", key: "headcount" },
  { label: "Core Focus", key: "focus" },
  { label: "Approach", key: "approach" },
  { label: "Target Customer", key: "target" },
  { label: "Deployment Model", key: "deployment" },
  { label: "AI Capability", key: "aiCapability" },
  { label: "SNAP Depth", key: "snapDepth" },
  { label: "PII Handling", key: "piiHandling" },
  { label: "Pricing Model", key: "pricing" },
];

function Badge({ type }) {
  const colors = {
    Us: "bg-cushion-600 text-white",
    "Primary Competitor": "bg-red-100 text-red-800",
    Adjacent: "bg-amber-100 text-amber-800",
    Incumbent: "bg-gray-200 text-gray-700",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${colors[type] || "bg-gray-100 text-gray-600"}`}>
      {type}
    </span>
  );
}

function CompetitorCard({ competitor }) {
  const border = competitor.highlight ? "border-cushion-500 ring-2 ring-cushion-100" : "border-gray-200";
  return (
    <div className={`border rounded-lg p-5 ${border} bg-white`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-bold text-gray-900">{competitor.name}</h3>
        <Badge type={competitor.type} />
      </div>
      <p className="text-sm text-gray-600 mb-4">{competitor.focus}</p>
      <div className="space-y-3">
        <div>
          <h4 className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-1">Strengths</h4>
          <ul className="space-y-1">
            {competitor.strengths.map((s, i) => (
              <li key={i} className="text-xs text-gray-700 flex items-start gap-1.5">
                <span className="text-green-500 mt-0.5 shrink-0">+</span>
                {s}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">Weaknesses</h4>
          <ul className="space-y-1">
            {competitor.weaknesses.map((w, i) => (
              <li key={i} className="text-xs text-gray-700 flex items-start gap-1.5">
                <span className="text-red-400 mt-0.5 shrink-0">&ndash;</span>
                {w}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default function CompetitiveAnalysis() {
  return (
    <>
      <SkipLink />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <header className="bg-cushion-800 text-white shadow-sm">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-lg sm:text-xl font-bold tracking-tight">Cushion Gov</h1>
              <span className="hidden sm:inline text-cushion-100 text-sm">Competitive Analysis</span>
            </div>
            <Link to="/admin/dashboard" className="text-sm text-cushion-200 hover:text-white transition-colors">
              Back to Admin
            </Link>
          </div>
        </header>

        <main id="main-content" role="main" className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-8">
          {/* Title Section */}
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Competitive Landscape</h2>
            <p className="text-sm text-gray-500 mt-1">
              Nava PBC and the broader govtech benefits delivery market — updated April 2026
            </p>
          </div>

          {/* Summary Cards */}
          <section aria-label="Competitor overview cards">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {competitors.map((c) => (
                <CompetitorCard key={c.name} competitor={c} />
              ))}
            </div>
          </section>

          {/* Comparison Table */}
          <section aria-label="Detailed comparison table">
            <h3 className="text-lg font-bold text-gray-900 mb-3">Head-to-Head Comparison</h3>
            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 sticky left-0 bg-gray-50 min-w-[140px]">
                      Dimension
                    </th>
                    {competitors.map((c) => (
                      <th
                        key={c.name}
                        className={`text-left px-4 py-3 font-semibold min-w-[200px] ${
                          c.highlight ? "text-cushion-700 bg-cushion-50" : "text-gray-700"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {c.name}
                          <Badge type={c.type} />
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dimensionRows.map((row, idx) => (
                    <tr key={row.key} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>
                      <td className={`px-4 py-3 font-medium text-gray-600 sticky left-0 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50"}`}>
                        {row.label}
                      </td>
                      {competitors.map((c) => (
                        <td
                          key={c.name}
                          className={`px-4 py-3 text-gray-700 ${c.highlight ? "bg-cushion-50/40" : ""}`}
                        >
                          {c[row.key]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Strategic Takeaways */}
          <section aria-label="Strategic takeaways" className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white border border-green-200 rounded-lg p-5">
              <h4 className="font-bold text-green-800 mb-2">Our Advantages</h4>
              <ul className="text-sm text-gray-700 space-y-2">
                <li><span className="font-medium text-green-700">AI-native intake:</span> No competitor has conversational AI that collects financial data, calculates eligibility, and flags anomalies in one flow.</li>
                <li><span className="font-medium text-green-700">Zero-PII architecture:</span> Dramatically simplifies compliance and security review — a unique selling point for risk-averse county IT.</li>
                <li><span className="font-medium text-green-700">County-level entry:</span> We can deploy without state-level procurement. Nava and Deloitte can't economically pursue individual counties.</li>
                <li><span className="font-medium text-green-700">Speed to value:</span> Weeks to pilot, not months of consulting. County directors see results fast.</li>
              </ul>
            </div>
            <div className="bg-white border border-red-200 rounded-lg p-5">
              <h4 className="font-bold text-red-800 mb-2">Key Risks</h4>
              <ul className="text-sm text-gray-700 space-y-2">
                <li><span className="font-medium text-red-700">Nava + Beam:</span> If Beam adds AI intake features and Nava bundles it with state contracts, they could block our county-up strategy.</li>
                <li><span className="font-medium text-red-700">State mandates:</span> A state choosing Nava/Deloitte for a statewide system could dictate county tooling, locking us out.</li>
                <li><span className="font-medium text-red-700">Scale gap:</span> 600+ staff vs. our small team. Concurrent multi-county deployments will strain resources.</li>
                <li><span className="font-medium text-red-700">Credibility gap:</span> No HealthCare.gov story. Pilot results are essential to build trust.</li>
              </ul>
            </div>
            <div className="bg-white border border-cushion-200 rounded-lg p-5">
              <h4 className="font-bold text-cushion-800 mb-2">Strategic Priorities</h4>
              <ul className="text-sm text-gray-700 space-y-2">
                <li><span className="font-medium text-cushion-700">1. Win the GA pilot:</span> Measurable results (time saved, accuracy, expedited cases caught) become our credibility story.</li>
                <li><span className="font-medium text-cushion-700">2. Stay SNAP-deep:</span> Resist the urge to go broad. Depth beats breadth at this stage.</li>
                <li><span className="font-medium text-cushion-700">3. County relationships:</span> Build direct relationships that top-down consultancies can't easily replicate.</li>
                <li><span className="font-medium text-cushion-700">4. Watch Beam closely:</span> Monitor Nava's Beam roadmap for AI intake features — that's the trigger to accelerate.</li>
              </ul>
            </div>
          </section>

          <footer className="text-xs text-gray-400 pb-6">
            Internal use only. Last updated April 2026.
          </footer>
        </main>
      </div>
    </>
  );
}
