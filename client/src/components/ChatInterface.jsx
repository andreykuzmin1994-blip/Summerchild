import { useState, useRef, useEffect } from "react";
import QuickReplyButtons from "./QuickReplyButtons";

const SECTION_QUICK_REPLIES = {
  WELCOME: [
    { label: "Yes, let's get started", value: "Yes, let's get started" },
    { label: "I have a question first", value: "I have a question about the process" },
  ],
  HOUSEHOLD: [
    { label: "Yes", value: "Yes" },
    { label: "No", value: "No" },
    { label: "I'm not sure", value: "I'm not sure" },
  ],
  INCOME: [
    { label: "Weekly", value: "Weekly" },
    { label: "Biweekly", value: "Every two weeks" },
    { label: "Twice a month", value: "Twice a month" },
    { label: "Monthly", value: "Monthly" },
    { label: "No more income sources", value: "That's all the income I have" },
  ],
  EXPENSES: [
    { label: "Yes", value: "Yes" },
    { label: "No", value: "No" },
    { label: "I'm not sure", value: "I'm not sure about that" },
  ],
  REVIEW: [
    { label: "Everything looks correct", value: "Everything looks correct" },
    { label: "I need to make a correction", value: "I need to correct something" },
  ],
};

export default function ChatInterface({ messages, onSendMessage, section, isLoading }) {
  const [input, setInput] = useState("");
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input after loading completes
  useEffect(() => {
    if (!isLoading) {
      inputRef.current?.focus();
    }
  }, [isLoading]);

  const handleSend = (text) => {
    const msg = text || input.trim();
    if (!msg || isLoading) return;
    onSendMessage(msg);
    setInput("");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const quickReplies = SECTION_QUICK_REPLIES[section] || [];

  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <div
        className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-4 chat-scroll"
        role="log"
        aria-label="Conversation with intake assistant"
        aria-live="polite"
      >
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] sm:max-w-[80%] rounded-2xl px-4 py-3 ${
                msg.role === "user"
                  ? "bg-cushion-600 text-white rounded-br-md"
                  : "bg-gray-100 text-gray-800 rounded-bl-md"
              }`}
              role="article"
              aria-label={msg.role === "user" ? "Your message" : "Assistant message"}
            >
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                <span className="sr-only">{msg.role === "user" ? "You said: " : "Assistant said: "}</span>
                {msg.content}
              </p>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-2xl rounded-bl-md px-4 py-3" role="status" aria-label="Assistant is typing">
              <div className="flex space-x-1" aria-hidden="true">
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
              <span className="sr-only">Assistant is thinking...</span>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Quick reply buttons */}
      {quickReplies.length > 0 && !isLoading && (
        <QuickReplyButtons replies={quickReplies} onSelect={handleSend} />
      )}

      {/* Input area */}
      <div className="border-t border-gray-200 p-3 sm:p-4">
        <div className="flex items-center space-x-2">
          <label htmlFor="chat-input" className="sr-only">Type your answer</label>
          <input
            id="chat-input"
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your answer..."
            className="flex-1 border border-gray-300 rounded-full px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cushion-500 focus:border-transparent"
            disabled={isLoading}
            aria-describedby="chat-help"
            autoComplete="off"
          />
          <button
            onClick={() => handleSend()}
            disabled={isLoading || !input.trim()}
            className="bg-cushion-600 text-white rounded-full px-4 sm:px-5 py-2 text-sm font-medium hover:bg-cushion-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500 focus:ring-offset-2"
            aria-label="Send message"
          >
            Send
          </button>
        </div>
        <p id="chat-help" className="sr-only">Press Enter to send your message, or use the quick reply buttons above</p>
        <button
          onClick={() => handleSend("I have a question about the process")}
          disabled={isLoading}
          className="mt-2 text-xs text-cushion-600 hover:text-cushion-800 underline focus:outline-none focus:ring-2 focus:ring-cushion-500 rounded"
        >
          I have a question
        </button>
      </div>
    </div>
  );
}
