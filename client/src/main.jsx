import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import IntakePage from "./pages/IntakePage";
import CaseworkerDashboard from "./pages/CaseworkerDashboard";
import IntakeDetail from "./pages/IntakeDetail";
import LoginPage from "./pages/LoginPage";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<IntakePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/caseworker/dashboard" element={<CaseworkerDashboard />} />
        <Route path="/caseworker/intake/:id" element={<IntakeDetail />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
