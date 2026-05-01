import { Routes, Route, Navigate } from "react-router-dom";
import { useEffect } from "react";
import { useAuth } from "./lib/auth";
import LoginPage from "./pages/Login";
import DashboardPage from "./pages/Dashboard";
import EditorPage from "./pages/Editor";
import AdminPage from "./pages/Admin";
import SettingsPage from "./pages/Settings";

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-text-muted">
        Loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AdminOnly({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-text-muted">
        Loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { check } = useAuth();
  useEffect(() => {
    check();
  }, [check]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Protected><DashboardPage /></Protected>} />
      <Route path="/workspace/:id" element={<Protected><EditorPage /></Protected>} />
      <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/admin" element={<AdminOnly><AdminPage /></AdminOnly>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
