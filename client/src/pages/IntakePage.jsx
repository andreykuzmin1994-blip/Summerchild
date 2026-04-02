import { useState, useCallback, useEffect } from "react";
import ChatInterface from "../components/ChatInterface";
import ProgressBar from "../components/ProgressBar";
import ReviewSummary from "../components/ReviewSummary";
import ErrorBanner from "../components/ErrorBanner";
import SkipLink from "../components/SkipLink";
import SessionTimeoutWarning from "../components/SessionTimeoutWarning";

const API_BASE = "/api/intake";

/**
 * Parse rate limit headers and throw informative errors.
 * County kiosk compliance: messages must be clear at an 8th-grade reading level.
 */
function handleHttpError(res) {
  if (res.status === 440) throw new Error("SESSION_EXPIRED");
  if (res.status === 429) {
    // Parse standard rate limit headers for a helpful countdown
    const retryAfter = res.headers.get("Retry-After");
    const remaining = res.headers.get("RateLimit-Remaining");
    const resetTime = res.headers.get("RateLimit-Reset");

    let waitSeconds = retryAfter ? parseInt(retryAfter, 10) : null;
    if (!waitSeconds && resetTime) {
      waitSeconds = Math.max(1, Math.ceil((parseInt(resetTime, 10) * 1000 - Date.now()) / 1000));
    }

    const waitMessage = waitSeconds
      ? `Please wait ${waitSeconds} seconds before sending another message.`
      : "Please wait a moment before sending another message.";

    throw new Error(`RATE_LIMITED:${waitSeconds || 30}:${waitMessage}`);
  }
  if (res.status >= 500) throw new Error("Our system is temporarily unavailable. Please try again in a moment.");
  if (!res.ok) throw new Error("Something went wrong. Please try again.");
}

export default function IntakePage() {
  const [sessionToken, setSessionToken] = useState(null);
  const [intakeId, setIntakeId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [section, setSection] = useState("WELCOME");
  const [isLoading, setIsLoading] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [summary, setSummary] = useState(null);
  const [completed, setCompleted] = useState(false);
  const [language, setLanguage] = useState(null);
  const [error, setError] = useState(null);
  const [lastActivity, setLastActivity] = useState(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [nameStep, setNameStep] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [nameError, setNameError] = useState("");
  const [queueNumber, setQueueNumber] = useState(null);
  const [rateLimitCountdown, setRateLimitCountdown] = useState(0);

  useEffect(() => {
    document.documentElement.lang = language || "en";
  }, [language]);

  // Rate limit countdown timer
  useEffect(() => {
    if (rateLimitCountdown <= 0) return;
    const timer = setInterval(() => {
      setRateLimitCountdown((prev) => {
        if (prev <= 1) {
          setError(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [rateLimitCountdown]);

  const handleSessionExpired = useCallback(() => {
    setSessionExpired(true);
  }, []);

  const startSession = async (selectedLanguage) => {
    setLanguage(selectedLanguage);
    setNameStep(true);
  };

  const submitNameAndStart = async () => {
    const trimmed = displayName.trim();
    if (trimmed.length < 2) {
      setNameError(
        language === "es"
          ? "Por favor ingrese su nombre y la primera letra de su apellido (ej: Maria G.)"
          : "Please enter your first name and last initial (e.g., Maria G.)"
      );
      return;
    }
    setNameError("");
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, displayName: trimmed }),
      });
      handleHttpError(res);
      const data = await res.json();
      setSessionToken(data.sessionToken);
      setIntakeId(data.intakeId);
      setQueueNumber(data.queueNumber);
      setMessages([{ role: "assistant", content: data.message }]);
      setSection(data.section);
      setLastActivity(Date.now());
    } catch (err) {
      if (err.message === "SESSION_EXPIRED") { setSessionExpired(true); return; }
      setError(err.message);
      setLanguage(null);
    }
    setIsLoading(false);
  };

  const sendMessage = async (text) => {
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken, message: text }),
      });
      handleHttpError(res);
      const data = await res.json();

      setLastActivity(Date.now());
      setMessages((prev) => [...prev, { role: "assistant", content: data.message }]);
      if (!data.blocked) {
        setSection(data.section);
        if (data.section === "REVIEW") {
          loadSummary();
        }
      }
    } catch (err) {
      if (err.message === "SESSION_EXPIRED") { setSessionExpired(true); return; }

      // Handle rate limiting with countdown
      if (err.message.startsWith("RATE_LIMITED:")) {
        const parts = err.message.split(":");
        const seconds = parseInt(parts[1], 10) || 30;
        const userMessage = parts.slice(2).join(":");
        setRateLimitCountdown(seconds);
        setError(userMessage);
        // Remove the user's message that wasn't sent
        setMessages((prev) => prev.slice(0, -1));
      } else {
        setError(err.message);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "I'm sorry, something went wrong. Please try again." },
        ]);
      }
    }
    setIsLoading(false);
  };

  const loadSummary = async () => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/${intakeId}/summary`, {
        headers: { "X-Session-Token": sessionToken },
      });
      handleHttpError(res);
      const data = await res.json();
      setSummary(data);
      setShowReview(true);
    } catch (err) {
      if (err.message === "SESSION_EXPIRED") { setSessionExpired(true); return; }
      setError(err.message);
    }
  };

  const handleConfirm = async () => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/${intakeId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken }),
      });
      handleHttpError(res);
      setCompleted(true);
    } catch (err) {
      if (err.message === "SESSION_EXPIRED") { setSessionExpired(true); return; }
      setError(err.message);
    }
  };

  // Welcome screen (language selection)
  if (!language) {
    return (
      <>
        <SkipLink />
        <div className="min-h-screen bg-gradient-to-b from-cushion-50 to-white flex items-center justify-center p-4">
          <main id="main-content" className="max-w-md w-full text-center space-y-8" role="main">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-cushion-800">Welcome to DFCS</h1>
              <p className="text-gray-600 mt-2">
                I'm here to help you prepare for your benefits interview.
              </p>
            </div>

            <ErrorBanner message={error} onRetry={() => setError(null)} />

            <div className="space-y-3" role="group" aria-label="Language selection">
              <p className="text-sm text-gray-500">Select your language / Seleccione su idioma</p>
              <button
                onClick={() => startSession("en")}
                disabled={isLoading}
                className="w-full bg-cushion-600 text-white rounded-lg py-4 text-lg font-medium hover:bg-cushion-700 disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500 focus:ring-offset-2"
                aria-label="Continue in English"
              >
                {isLoading ? "Starting..." : "English"}
              </button>
              <button
                onClick={() => startSession("es")}
                disabled={isLoading}
                className="w-full border-2 border-cushion-600 text-cushion-700 rounded-lg py-4 text-lg font-medium hover:bg-cushion-50 disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500 focus:ring-offset-2"
                aria-label="Continuar en Español"
              >
                {isLoading ? "Iniciando..." : "Español"}
              </button>
            </div>

            <p className="text-xs text-gray-400">
              Cushion Gov — SNAP Intake Assistant
            </p>
          </main>
        </div>
      </>
    );
  }

  // Name input step (after language, before chat)
  if (nameStep && !sessionToken) {
    return (
      <>
        <SkipLink />
        <div className="min-h-screen bg-gradient-to-b from-cushion-50 to-white flex items-center justify-center p-4">
          <main id="main-content" className="max-w-md w-full text-center space-y-6" role="main">
            <div>
              <h1 className="text-2xl font-bold text-cushion-800">
                {language === "es" ? "Antes de comenzar" : "Before We Begin"}
              </h1>
              <p className="text-gray-600 mt-2">
                {language === "es"
                  ? "Por favor ingrese su nombre y la primera letra de su apellido."
                  : "Please enter your first name and last initial."}
              </p>
              <p className="text-sm text-gray-500 mt-1">
                {language === "es"
                  ? "Ejemplo: Maria G."
                  : "Example: Maria G."}
              </p>
            </div>

            <ErrorBanner message={error} onRetry={() => setError(null)} />

            <div className="space-y-3">
              <label htmlFor="displayNameInput" className="sr-only">
                {language === "es" ? "Nombre y primera letra del apellido" : "First name and last initial"}
              </label>
              <input
                id="displayNameInput"
                type="text"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setNameError(""); }}
                placeholder={language === "es" ? "Maria G." : "Maria G."}
                className="w-full border-2 border-gray-300 rounded-lg py-3 px-4 text-lg text-center focus:outline-none focus:ring-2 focus:ring-cushion-500 focus:border-cushion-500"
                aria-describedby={nameError ? "nameError" : undefined}
                aria-invalid={nameError ? "true" : "false"}
              />
              {nameError && (
                <p id="nameError" role="alert" className="text-red-600 text-sm">
                  {nameError}
                </p>
              )}
              <button
                onClick={submitNameAndStart}
                disabled={isLoading}
                className="w-full bg-cushion-600 text-white rounded-lg py-4 text-lg font-medium hover:bg-cushion-700 disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500 focus:ring-offset-2"
              >
                {isLoading
                  ? (language === "es" ? "Iniciando..." : "Starting...")
                  : (language === "es" ? "Continuar" : "Continue")}
              </button>
            </div>
          </main>
        </div>
      </>
    );
  }

  // Completion screen
  if (completed) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-green-50 to-white flex items-center justify-center p-4">
        <main id="main-content" className="max-w-md w-full text-center space-y-6" role="main">
          <div className="w-20 h-20 bg-green-500 rounded-full flex items-center justify-center mx-auto" role="img" aria-label="Success">
            <span className="text-white text-4xl" aria-hidden="true">{"\u2713"}</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-800">Thank You</h1>
          <p className="text-gray-600">
            Your information has been sent to the caseworker.
            Please wait for your number to be called.
          </p>
          {queueNumber && (
            <div className="bg-cushion-50 border-2 border-cushion-200 rounded-lg p-4">
              <p className="text-sm text-gray-500">Your Queue Number</p>
              <p className="text-3xl font-mono font-bold text-cushion-800" aria-label={`Queue number ${queueNumber}`}>
                {queueNumber}
              </p>
            </div>
          )}
          <div className="bg-gray-100 rounded-lg p-4">
            <p className="text-sm text-gray-500">Intake Reference</p>
            <p className="text-lg font-mono font-bold text-gray-800" aria-label={`Intake reference number C U ${intakeId?.slice(0, 8).toUpperCase()}`}>
              CU-{intakeId?.slice(0, 8).toUpperCase()}
            </p>
          </div>
          {summary?.intake?.documentChecklist?.length > 0 && (
            <div className="text-left bg-white border rounded-lg p-4">
              <h2 className="font-semibold text-gray-800 mb-2">Documents to Bring</h2>
              <ul className="space-y-1 text-sm text-gray-600">
                {summary.intake.documentChecklist.map((doc, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-gray-400 mt-0.5">{doc.required ? "\u25A1" : "\u25AB"}</span>
                    <span>{doc.description}{!doc.required && " (if applicable)"}</span>
                  </li>
                ))}
              </ul>
              <button
                onClick={() => window.print()}
                className="mt-4 w-full border-2 border-gray-300 text-gray-700 rounded-lg py-3 text-sm font-medium hover:bg-gray-50 transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500 focus:ring-offset-2"
              >
                Print Document Checklist
              </button>
            </div>
          )}
        </main>
      </div>
    );
  }

  // Review screen
  if (showReview && summary) {
    return (
      <>
        <SkipLink />
        <SessionTimeoutWarning lastActivity={lastActivity} onExpired={handleSessionExpired} />
        <div className="min-h-screen bg-white">
          <ProgressBar currentSection="REVIEW" />
          <main id="main-content" role="main">
            <ErrorBanner message={error} onRetry={loadSummary} />
            <ReviewSummary
              summary={summary}
              onConfirm={handleConfirm}
              onEdit={() => {
                setShowReview(false);
                sendMessage("I need to correct something");
              }}
            />
          </main>
        </div>
      </>
    );
  }

  // Chat screen
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <SessionTimeoutWarning lastActivity={lastActivity} onExpired={handleSessionExpired} />
      <div className="h-screen flex flex-col bg-white">
        <ProgressBar currentSection={section} />
        <main id="main-content" className="flex-1 overflow-hidden" role="main">
          <ErrorBanner message={error} onRetry={() => setError(null)} rateLimitCountdown={rateLimitCountdown} />
          <ChatInterface
            messages={messages}
            onSendMessage={sendMessage}
            section={section}
            isLoading={isLoading || rateLimitCountdown > 0}
            rateLimitCountdown={rateLimitCountdown}
          />
        </main>
      </div>
    </>
  );
}
