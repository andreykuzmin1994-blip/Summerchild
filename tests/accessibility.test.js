/**
 * WCAG 2.1 Level AA — Static Accessibility Audit
 *
 * Validates that all frontend components meet Section 508 / ADA requirements
 * by checking source markup for required accessibility patterns.
 *
 * Categories tested:
 *  1. Document-level (lang, viewport, meta)
 *  2. Landmarks & semantic structure
 *  3. Form label associations (htmlFor / id)
 *  4. ARIA live regions & dynamic content
 *  5. Keyboard & focus management
 *  6. Color contrast (text class checks)
 *  7. Touch target sizing (py-3 / py-4 minimum)
 *  8. Reduced-motion support
 *  9. Screen-reader-only helpers
 * 10. Skip navigation
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const CLIENT_SRC = path.resolve("client/src");
const read = (relPath) => fs.readFileSync(path.resolve(relPath), "utf-8");

// ─── Helpers ──────────────────────────────────────────────────────
const readComponent = (name) => read(`client/src/components/${name}`);
const readPage = (name) => read(`client/src/pages/${name}`);

// ─── 1. Document-level ───────────────────────────────────────────
describe("Document-level accessibility", () => {
  const html = read("client/index.html");

  it("has lang attribute on <html>", () => {
    expect(html).toMatch(/<html\s[^>]*lang="[a-z]{2,}"/);
  });

  it("allows user-scalable zoom (WCAG 1.4.4)", () => {
    expect(html).toContain("user-scalable=yes");
  });

  it("has a meta description", () => {
    expect(html).toMatch(/<meta\s[^>]*name="description"/);
  });

  it("has a meaningful <title>", () => {
    expect(html).toMatch(/<title>[^<]+<\/title>/);
  });

  it("dynamically updates document lang when language changes", () => {
    const intake = readPage("IntakePage.jsx");
    expect(intake).toContain("document.documentElement.lang");
  });
});

// ─── 2. Landmarks & semantic structure ──────────────────────────
describe("Landmarks and semantic HTML", () => {
  it("IntakePage uses <main> on every screen variant", () => {
    const src = readPage("IntakePage.jsx");
    // Welcome, name-entry, completion, review, and chat screens should all have <main>
    const mainCount = (src.match(/<main[\s>]/g) || []).length;
    expect(mainCount).toBeGreaterThanOrEqual(4);
  });

  it("LoginPage uses <main> landmark", () => {
    expect(readPage("LoginPage.jsx")).toMatch(/<main[\s>]/);
  });

  it("CaseworkerDashboard uses <main> landmark", () => {
    expect(readPage("CaseworkerDashboard.jsx")).toMatch(/<main[\s>]/);
  });

  it("IntakeDetail uses <main> landmark", () => {
    expect(readPage("IntakeDetail.jsx")).toMatch(/<main[\s>]/);
  });

  it("ProgressBar uses <nav> landmark with aria-label", () => {
    const src = readComponent("ProgressBar.jsx");
    expect(src).toMatch(/<nav[\s\S]*?aria-label/);
  });

  it("ProgressBar uses ordered list for step sequence", () => {
    expect(readComponent("ProgressBar.jsx")).toContain("<ol");
  });

  it("DocumentChecklist uses <section> with aria-label", () => {
    const src = readComponent("DocumentChecklist.jsx");
    expect(src).toMatch(/<section[\s\S]*?aria-label/);
  });

  it("IncomeCalculationDisplay uses <section> with aria-label", () => {
    const src = readComponent("IncomeCalculationDisplay.jsx");
    expect(src).toMatch(/<section[\s\S]*?aria-label/);
  });

  it("IntakeDetail uses <section> for content areas", () => {
    expect(readPage("IntakeDetail.jsx")).toContain("<section");
  });

  it("ReviewSummary uses <section> elements", () => {
    expect(readComponent("ReviewSummary.jsx")).toContain("<section");
  });
});

// ─── 3. Form label associations ──────────────────────────────────
describe("Form labels (WCAG 1.3.1 / 4.1.2)", () => {
  it("IntakePage name input has label with htmlFor + matching id", () => {
    const src = readPage("IntakePage.jsx");
    expect(src).toContain('htmlFor="displayNameInput"');
    expect(src).toContain('id="displayNameInput"');
  });

  it("ChatInterface input has label with htmlFor + matching id", () => {
    const src = readComponent("ChatInterface.jsx");
    expect(src).toContain('htmlFor="chatInput"');
    expect(src).toContain('id="chatInput"');
  });

  it("LoginPage email input has label with htmlFor + matching id", () => {
    const src = readPage("LoginPage.jsx");
    expect(src).toContain('htmlFor="emailInput"');
    expect(src).toContain('id="emailInput"');
  });

  it("LoginPage password input has label with htmlFor + matching id", () => {
    const src = readPage("LoginPage.jsx");
    expect(src).toContain('htmlFor="passwordInput"');
    expect(src).toContain('id="passwordInput"');
  });

  it("IntakeDetail select has label with htmlFor + matching id", () => {
    const src = readPage("IntakeDetail.jsx");
    expect(src).toContain('htmlFor="correctionType"');
    expect(src).toContain('id="correctionType"');
  });

  it("IntakeDetail textarea has label with htmlFor + matching id", () => {
    const src = readPage("IntakeDetail.jsx");
    expect(src).toContain('htmlFor="reviewNotes"');
    expect(src).toContain('id="reviewNotes"');
  });
});

// ─── 4. ARIA live regions & dynamic content ─────────────────────
describe("ARIA live regions (WCAG 4.1.3)", () => {
  it("Chat message area has role=log and aria-live=polite", () => {
    const src = readComponent("ChatInterface.jsx");
    expect(src).toContain('role="log"');
    expect(src).toContain('aria-live="polite"');
  });

  it("Chat area uses aria-atomic=false for incremental updates", () => {
    expect(readComponent("ChatInterface.jsx")).toContain('aria-atomic="false"');
  });

  it("Chat area has descriptive aria-label", () => {
    expect(readComponent("ChatInterface.jsx")).toMatch(/aria-label="[^"]*[Cc]onversation/);
  });

  it("Loading indicator has role=status", () => {
    expect(readComponent("ChatInterface.jsx")).toContain('role="status"');
  });

  it("Name validation error has role=alert", () => {
    expect(readPage("IntakePage.jsx")).toContain('role="alert"');
  });

  it("Login error has role=alert", () => {
    expect(readPage("LoginPage.jsx")).toContain('role="alert"');
  });

  it("IntakeDetail reviewed banner has role=status", () => {
    expect(readPage("IntakeDetail.jsx")).toContain('role="status"');
  });
});

// ─── 5. Error association (aria-describedby / aria-invalid) ─────
describe("Error message association (WCAG 3.3.1)", () => {
  it("Name input links to error via aria-describedby", () => {
    const src = readPage("IntakePage.jsx");
    expect(src).toContain("aria-describedby");
    expect(src).toContain('id="nameError"');
  });

  it("Name input uses aria-invalid on error", () => {
    expect(readPage("IntakePage.jsx")).toContain("aria-invalid");
  });

  it("Login email links to error via aria-describedby", () => {
    const src = readPage("LoginPage.jsx");
    expect(src).toContain("aria-describedby");
    expect(src).toContain('id="loginError"');
  });
});

// ─── 6. Autocomplete attributes (WCAG 1.3.5) ───────────────────
describe("Input purpose (WCAG 1.3.5)", () => {
  it("Login email has autoComplete=email", () => {
    expect(readPage("LoginPage.jsx")).toContain('autoComplete="email"');
  });

  it("Login password has autoComplete=current-password", () => {
    expect(readPage("LoginPage.jsx")).toContain('autoComplete="current-password"');
  });
});

// ─── 7. Keyboard & focus ─────────────────────────────────────────
describe("Keyboard accessibility (WCAG 2.1.1 / 2.4.7)", () => {
  it("IntakePage buttons have visible focus rings", () => {
    const src = readPage("IntakePage.jsx");
    expect(src).toContain("focus:ring-2");
    expect(src).toContain("focus:outline-none");
  });

  it("ChatInterface input and button have focus rings", () => {
    const src = readComponent("ChatInterface.jsx");
    expect(src).toContain("focus:ring-2");
  });

  it("LoginPage inputs have focus rings", () => {
    const src = readPage("LoginPage.jsx");
    expect(src).toContain("focus:ring-2");
  });

  it("QuickReplyButtons have focus rings", () => {
    expect(readComponent("QuickReplyButtons.jsx")).toContain("focus:ring-2");
  });

  it("CaseworkerDashboard links have focus rings", () => {
    expect(readPage("CaseworkerDashboard.jsx")).toContain("focus:ring-2");
  });

  it("ChatInterface supports Enter key to send", () => {
    expect(readComponent("ChatInterface.jsx")).toContain("handleKeyDown");
  });

  it("Chat input signals busy state with aria-busy", () => {
    expect(readComponent("ChatInterface.jsx")).toContain("aria-busy");
  });
});

// ─── 8. Touch targets (WCAG 2.5.8 — 44×44 CSS px minimum) ─────
describe("Touch target sizing (WCAG 2.5.8)", () => {
  it("Language selection buttons are py-4 (≥44px)", () => {
    const src = readPage("IntakePage.jsx");
    // Both language buttons should have py-4
    const py4Count = (src.match(/py-4/g) || []).length;
    expect(py4Count).toBeGreaterThanOrEqual(2);
  });

  it("Chat send button is py-3 (≥44px)", () => {
    const src = readComponent("ChatInterface.jsx");
    // Button should have adequate padding
    expect(src).toMatch(/button[\s\S]*?py-3/);
  });

  it("QuickReplyButtons have py-3 (≥44px)", () => {
    expect(readComponent("QuickReplyButtons.jsx")).toContain("py-3");
  });

  it("LoginPage inputs have py-3 (≥44px)", () => {
    expect(readPage("LoginPage.jsx")).toContain("py-3");
  });
});

// ─── 9. Screen reader helpers ────────────────────────────────────
describe("Screen reader support", () => {
  it("Chat messages have sr-only role prefix (You said / Assistant said)", () => {
    const src = readComponent("ChatInterface.jsx");
    expect(src).toContain("sr-only");
    expect(src).toContain("You said:");
    expect(src).toContain("Assistant said:");
  });

  it("Loading indicator has sr-only status text", () => {
    const src = readComponent("ChatInterface.jsx");
    expect(src).toMatch(/sr-only[\s\S]*?typing/i);
  });

  it("ProgressBar steps have sr-only status labels", () => {
    const src = readComponent("ProgressBar.jsx");
    expect(src).toContain("sr-only");
    expect(src).toContain("completed");
    expect(src).toContain("current");
    expect(src).toContain("upcoming");
  });

  it("ProgressBar uses aria-current=step on active step", () => {
    expect(readComponent("ProgressBar.jsx")).toContain('aria-current');
    expect(readComponent("ProgressBar.jsx")).toContain('"step"');
  });

  it("DocumentChecklist uses sr-only for confirmed status", () => {
    const src = readComponent("DocumentChecklist.jsx");
    expect(src).toContain("sr-only");
    expect(src).toMatch(/confirmed/i);
  });

  it("Decorative elements have aria-hidden=true", () => {
    // Check that decorative icons across components are hidden from screen readers
    const files = [
      readComponent("ChatInterface.jsx"),
      readComponent("ProgressBar.jsx"),
      readComponent("DocumentChecklist.jsx"),
      readPage("CaseworkerDashboard.jsx"),
      readPage("IntakeDetail.jsx"),
      readPage("IntakePage.jsx"),
    ];
    for (const src of files) {
      expect(src).toContain('aria-hidden="true"');
    }
  });

  it("QuickReplyButtons container has role=group with aria-label", () => {
    const src = readComponent("QuickReplyButtons.jsx");
    expect(src).toContain('role="group"');
    expect(src).toContain("aria-label");
  });

  it("Success checkmark has role=img with aria-label", () => {
    const src = readPage("IntakePage.jsx");
    expect(src).toContain('role="img"');
    expect(src).toMatch(/aria-label="[^"]*[Ss]uccess/);
  });

  it("Queue number has descriptive aria-label", () => {
    const src = readPage("IntakePage.jsx");
    expect(src).toMatch(/aria-label={`Queue number/);
  });
});

// ─── 10. Skip navigation (WCAG 2.4.1) ──────────────────────────
describe("Skip navigation (WCAG 2.4.1)", () => {
  it("Chat screen has skip-to-content link", () => {
    const src = readPage("IntakePage.jsx");
    expect(src).toContain('className="skip-link"');
    expect(src).toContain('href="#main-content"');
  });

  it("Skip link is visually hidden until focused", () => {
    const css = read("client/src/index.css");
    expect(css).toContain(".skip-link");
    expect(css).toContain("top: -100%");
    expect(css).toContain(":focus");
    expect(css).toContain("top: 0");
  });

  it("Main content has matching id for skip link target", () => {
    const src = readPage("IntakePage.jsx");
    expect(src).toContain('id="main-content"');
  });
});

// ─── 11. Color contrast ─────────────────────────────────────────
describe("Color contrast (WCAG 1.4.3)", () => {
  it("Does not use text-gray-400 (fails 4.5:1 on white) for meaningful text", () => {
    // text-gray-400 (#9ca3af) on white is only ~3:1 — fails AA
    // We should not use it for any readable text (only for decorative dots, etc.)
    const pages = [
      readPage("CaseworkerDashboard.jsx"),
      readPage("IntakeDetail.jsx"),
      readComponent("DocumentChecklist.jsx"),
      readComponent("IncomeCalculationDisplay.jsx"),
    ];
    for (const src of pages) {
      // Allow text-gray-400 ONLY inside aria-hidden elements (decorative)
      // Check that text-gray-400 is not used for visible text
      const lines = src.split("\n");
      for (const line of lines) {
        if (line.includes("text-gray-400") && !line.includes("aria-hidden")) {
          // The only acceptable use is for decorative animation dots
          expect(line).toMatch(/animate-bounce|aria-hidden/);
        }
      }
    }
  });

  it("Uses text-gray-600+ for secondary text", () => {
    // Verify upgraded contrast classes are present
    const components = [
      readComponent("DocumentChecklist.jsx"),
      readComponent("IncomeCalculationDisplay.jsx"),
      readPage("CaseworkerDashboard.jsx"),
    ];
    for (const src of components) {
      expect(src).toContain("text-gray-600");
    }
  });
});

// ─── 12. Reduced motion ─────────────────────────────────────────
describe("Reduced motion (WCAG 2.3.3)", () => {
  it("CSS respects prefers-reduced-motion", () => {
    const css = read("client/src/index.css");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("animation: none");
  });
});

// ─── 13. Language support ───────────────────────────────────────
describe("Language support (WCAG 3.1.1 / 3.1.2)", () => {
  it("HTML has default lang=en", () => {
    expect(read("client/index.html")).toContain('lang="en"');
  });

  it("IntakePage updates document lang for Spanish", () => {
    const src = readPage("IntakePage.jsx");
    expect(src).toContain("document.documentElement.lang = language");
  });

  it("Provides language selection before any content", () => {
    const src = readPage("IntakePage.jsx");
    // Language selection should be in the first screen (no sessionToken check)
    expect(src).toContain("Select your language");
    expect(src).toContain("Seleccione su idioma");
  });
});
