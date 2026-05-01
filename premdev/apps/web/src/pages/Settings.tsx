import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { API } from "@/lib/api";
import { Layout } from "@/components/Layout";
import { Loader2, Save } from "lucide-react";

export default function SettingsPage() {
  const { data, refetch } = useQuery({
    queryKey: ["me"],
    queryFn: () => API.get<{ user: any }>("/auth/me"),
  });

  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function changePw(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== pw2) return setMsg("Passwords don't match");
    setBusy(true);
    setMsg("");
    try {
      await API.post("/auth/change-password", { password: pw });
      setMsg("Password changed");
      setPw("");
      setPw2("");
    } catch (e: any) {
      setMsg(e.message || "Error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout>
      <div className="mx-auto max-w-3xl p-8">
        <h1 className="mb-6 text-2xl font-semibold">Settings</h1>

        <section className="card mb-6 p-6">
          <h2 className="mb-4 font-semibold">Profile</h2>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-text-muted">Username</span>
              <span>{data?.user?.username}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Email</span>
              <span>{data?.user?.email}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Role</span>
              <span className="capitalize">{data?.user?.role}</span>
            </div>
          </div>
        </section>

        <section className="card mb-6 p-6">
          <h2 className="mb-4 font-semibold">Database access</h2>
          <p className="mb-3 text-sm text-text-muted">
            Your MySQL user — projects auto-create databases prefixed with your username.
            All databases share this credential.
          </p>
          <div className="space-y-2 rounded-md bg-bg-subtle p-3 font-mono text-xs">
            <div>HOST: <span className="text-accent">mysql</span></div>
            <div>USER: <span className="text-accent">{data?.user?.username}</span></div>
            <div>PASSWORD: <span className="text-text-muted">(see env: DB_PASSWORD)</span></div>
            <div>DB PREFIX: <span className="text-accent">{data?.user?.username}_*</span></div>
          </div>
          <a
            href="/api/db/phpmyadmin-redirect"
            target="_blank"
            rel="noreferrer"
            className="btn-secondary mt-3"
          >
            Open phpMyAdmin
          </a>
        </section>

        <section className="card p-6">
          <h2 className="mb-4 font-semibold">Change password</h2>
          <form onSubmit={changePw} className="space-y-3">
            <div>
              <label className="label">New password</label>
              <input
                type="password"
                className="input"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                required
                minLength={8}
              />
            </div>
            <div>
              <label className="label">Confirm</label>
              <input
                type="password"
                className="input"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                required
                minLength={8}
              />
            </div>
            {msg && <div className="text-sm text-text-muted">{msg}</div>}
            <button className="btn-primary" disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </form>
        </section>
      </div>
    </Layout>
  );
}
