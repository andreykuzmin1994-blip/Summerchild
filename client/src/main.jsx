import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import NetworkStatus from "./components/NetworkStatus";
import IntakePage from "./pages/IntakePage";
import CaseworkerDashboard from "./pages/CaseworkerDashboard";
import IntakeDetail from "./pages/IntakeDetail";
import LoginPage from "./pages/LoginPage";
import SupervisorDashboard from "./pages/SupervisorDashboard";
import AdminDashboard from "./pages/AdminDashboard";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <NetworkStatus />
      <Routes>
        <Route path="/" element={<IntakePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/caseworker/dashboard" element={<CaseworkerDashboard />} />
        <Route path="/caseworker/intake/:id" element={<IntakeDetail />} />
        <Route path="/supervisor/dashboard" element={<SupervisorDashboard />} />
        <Route path="/admin/dashboard" element={<AdminDashboard />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
