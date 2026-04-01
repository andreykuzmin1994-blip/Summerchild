import { useState, useEffect } from "react";
import ChatInterface from "../components/ChatInterface";
import ProgressBar from "../components/ProgressBar";
import ReviewSummary from "../components/ReviewSummary";

const API_BASE = "/api/intake";

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
  const [queueNumber, setQueueNumber] = useState(null);
  const [displayName, setDisplayName] = useState("");
  const [nameStep, setNameStep] = useState(false);
  const [nameError, setNameError] = useState("");

  // Start session after name + language collected
  const startSession = async (selectedLanguage) => {
    setLanguage(selectedLanguage);
    setNameStep(true);
  };

  const submitNameAndStart = async () => {
    const trimmed = displayName.trim();
    if (trimmed.length < 2) {
      setNameError("Please enter your first name and last initial (e.g., Maria G.)");
      return;
    }
    setNameError("");
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, displayName: trimmed }),
      });
      const data = await res.json();
      setSessionToken(data.sessionToken);
      setIntakeId(data.intakeId);
      setQueueNumber(data.queueNumber);
      setMessages([{ role: "assistant", content: data.message }]);
      setSection(data.section);
      setNameStep(false);
    } catch (error) {
      console.error("Failed to start session:", error);
    }
    setIsLoading(false);
  };

  const sendMessage = async (text) => {
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setIsLoading(true);

    try {
      const res = await fetch(`${API_BASE}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken, message: text }),
      });
      const data = await res.json();

      if (data.blocked) {
        setMessages((prev) => [...prev, { role: "assistant", content: data.message }]);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: data.message }]);
        setSection(data.section);

        if (data.section === "REVIEW") {
          loadSummary();
        }
      }
    } catch (error) {
      console.error("Failed to send message:", error);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "I'm sorry, something went wrong. Please try again." },
      ]);
    }
    setIsLoading(false);
  };

  const loadSummary = async () => {
    try {
      const res = await fetch(`${API_BASE}/${intakeId}/summary?sessionToken=${sessionToken}`);
      const data = await res.json();
      setSummary(data);
      setShowReview(true);
    } catch (error) {
      console.error("Failed to load summary:", error);
    }
  };

  const handleConfirm = async () => {
    try {
      const res = await fetch(`${API_BASE}/${intakeId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken }),
      });
      const data = await res.json();
      setCompleted(true);
    } catch (error) {
      console.error("Failed to complete intake:", error);
    }
  };

  // Welcome screen (language selection)
  if (!language || (!sessionToken && !nameStep)) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-cushion-50 to-white flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center space-y-8">
          <div>
            <h1 className="text-3xl font-bold text-cushion-800">Welcome to DFCS</h1>
            <p className="text-gray-600 mt-2">
              I'm here to help you prepare for your benefits interview.
            </p>
          </div>

          <div className="space-y-3">
            <p className="text-sm text-gray-500">Select your language / Seleccione su idioma</p>
            <button
              onClick={() => startSession("en")}
              className="w-full bg-cushion-600 text-white rounded-lg py-4 text-lg font-medium hover:bg-cushion-700 transition-colors"
            >
              English
            </button>
            <button
              onClick={() => startSession("es")}
              className="w-full border-2 border-cushion-600 text-cushion-700 rounded-lg py-4 text-lg font-medium hover:bg-cushion-50 transition-colors"
            >
              Espanol
            </button>
          </div>

          <p className="text-xs text-gray-400">
            Cushion Gov — SNAP Intake Assistant
          </p>
        </div>
      </div>
    );
  }

  // Name entry screen (after language, before session start)
  if (nameStep && !sessionToken) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-cushion-50 to-white flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center space-y-6">
          <div>
            <h1 className="text-2xl font-bold text-cushion-800">
              {language === "es" ? "Antes de comenzar" : "Before we begin"}
            </h1>
            <p className="text-gray-600 mt-2">
              {language === "es"
                ? "Por favor ingrese su nombre y la primera letra de su apellido. Esto es solo para que el trabajador social pueda llamarlo de la sala de espera."
                : "Please enter your first name and last initial. This is only so the caseworker can call you from the waiting room."}
            </p>
          </div>

          <div className="space-y-3">
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitNameAndStart()}
              placeholder={language === "es" ? "Ejemplo: Maria G." : "Example: Maria G."}
              className="w-full border-2 border-gray-300 rounded-lg px-4 py-4 text-lg text-center focus:border-cushion-600 focus:outline-none"
              autoFocus
            />
            {nameError && <p className="text-red-500 text-sm">{nameError}</p>}
            <p className="text-xs text-gray-400">
              {language === "es"
                ? "No recopilamos su nombre completo, SSN, direccion ni telefono."
                : "We do not collect your full name, SSN, address, or phone number."}
            </p>
            <button
              onClick={submitNameAndStart}
              disabled={isLoading}
              className="w-full bg-cushion-600 text-white rounded-lg py-4 text-lg font-medium hover:bg-cushion-700 transition-colors disabled:opacity-50"
            >
              {isLoading ? (language === "es" ? "Iniciando..." : "Starting...") : (language === "es" ? "Comenzar" : "Get Started")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Completion screen
  if (completed) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-green-50 to-white flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="w-20 h-20 bg-green-500 rounded-full flex items-center justify-center mx-auto">
            <span className="text-white text-4xl">{"\u2713"}</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-800">Thank You</h1>
          <p className="text-gray-600">
            Your information has been sent to the caseworker.
            Please wait for your number to be called.
          </p>
          <div className="bg-gray-100 rounded-lg p-4">
            <p className="text-sm text-gray-500">Your Queue Number</p>
            <p className="text-3xl font-mono font-bold text-cushion-700">
              {queueNumber}
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-400">Reference: CU-{intakeId?.slice(0, 8).toUpperCase()}</p>
          </div>
        </div>
      </div>
    );
  }

  // Review screen
  if (showReview && summary) {
    return (
      <div className="min-h-screen bg-white">
        <ProgressBar currentSection="REVIEW" />
        <ReviewSummary
          summary={summary}
          onConfirm={handleConfirm}
          onEdit={() => {
            setShowReview(false);
            sendMessage("I need to correct something");
          }}
        />
      </div>
    );
  }

  // Chat screen
  return (
    <div className="h-screen flex flex-col bg-white">
      <ProgressBar currentSection={section} />
      <div className="flex-1 overflow-hidden">
        <ChatInterface
          messages={messages}
          onSendMessage={sendMessage}
          section={section}
          isLoading={isLoading}
        />
      </div>
    </div>
  );
}
