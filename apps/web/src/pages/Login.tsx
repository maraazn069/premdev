import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Code2, Loader2 } from "lucide-react";

export default function LoginPage() {
  const nav = useNavigate();
  const { login } = useAuth();
  const [u, setU] = useState(() => localStorage.getItem("premdev:lastUsername") || "");
  const [p, setP] = useState("");
  const [remember, setRemember] = useState(() => localStorage.getItem("premdev:remember") === "1");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await login(u, p, remember);
      // Persist the username so the field is pre-filled next visit; also
      // remember the checkbox state so the toggle stays on across sessions.
      // We never store the password in localStorage — the browser's own
      // password manager handles that via autoComplete.
      if (remember) {
        localStorage.setItem("premdev:lastUsername", u);
        localStorage.setItem("premdev:remember", "1");
      } else {
        localStorage.removeItem("premdev:lastUsername");
        localStorage.removeItem("premdev:remember");
      }
      nav("/", { replace: true });
    } catch (e: any) {
      setErr(e.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="card w-full max-w-md p-8 shadow-glow">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-accent text-white">
            <Code2 size={22} />
          </div>
          <div>
            <div className="text-lg font-semibold">PremDev</div>
            <div className="text-xs text-text-muted">Cloud IDE</div>
          </div>
        </div>

        <h1 className="mb-1 text-xl font-semibold">Welcome back</h1>
        <p className="mb-6 text-sm text-text-muted">
          Sign in to your workspace
        </p>

        <form className="space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="label">Username</label>
            <input
              className="input"
              value={u}
              onChange={(e) => setU(e.target.value)}
              autoFocus
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              value={p}
              onChange={(e) => setP(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-muted select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded border-border bg-bg-elev text-accent focus:ring-accent focus:ring-offset-0"
            />
            Ingat saya di perangkat ini (30 hari)
          </label>
          {err && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {err}
            </div>
          )}
          <button className="btn-primary w-full" disabled={busy}>
            {busy && <Loader2 size={16} className="animate-spin" />}
            Sign in
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-text-subtle">
          Default admin credentials are set during install
        </p>
      </div>
    </div>
  );
}
