import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { API } from "@/lib/api";
import { Layout } from "@/components/Layout";
import { Plus, Trash2, Loader2, Activity, Users, HardDrive, Cpu, Key, Eye, EyeOff, Save, Shield, ScrollText, LogIn, Cloud, RefreshCw, Play, Download, AlertTriangle, Sparkles, Search, Database, Zap, Server, Folder, FileText, ChevronRight, Home, FolderPlus, FilePen, X } from "lucide-react";
import { useConfirm } from "@/lib/useConfirm";

type Tab = "users" | "audit" | "logins" | "backup" | "semantic" | "vpsfiles";

type AdminUser = {
  id: string;
  username: string;
  email: string;
  role: "admin" | "user";
  quotaCpu: number;
  quotaMemMb: number;
  quotaDiskMb: number;
  maxWorkspaces: number;
  createdAt: string;
  workspaceCount?: number;
};

type SystemStats = {
  totalUsers: number;
  totalWorkspaces: number;
  runningWorkspaces: number;
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  diskUsedMb: number;
  diskTotalMb: number;
};

type AIKeyRow = {
  provider: "openai" | "anthropic" | "google" | "openrouter" | "groq" | "konektika" | "snifox";
  configured: boolean;
  source: "db" | "env" | "none";
  masked: string;
  // Multi-key failover: a single configured value may contain several
  // keys separated by `,` / `;` / newline. The backend already parses
  // them and rotates on rate-limit / 401 errors. Surface the count and
  // per-key masked previews here so admins can verify their failover
  // chain is set up correctly without revealing the secret bodies.
  keyCount: number;
  maskedAll: string[];
};

const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  groq: "Groq",
  konektika: "Konektika (kimi-pro)",
  snifox: "SnifoxAI (snfx-…)",
};

export default function AdminPage() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [showAdd, setShowAdd] = useState(false);
  const [tab, setTab] = useState<Tab>("users");

  const { data: users, isLoading: lu } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => API.get<{ users: AdminUser[] }>("/admin/users"),
  });
  const { data: stats } = useQuery({
    queryKey: ["admin", "stats"],
    queryFn: () => API.get<SystemStats>("/admin/stats"),
    refetchInterval: 5000,
  });

  const del = useMutation({
    mutationFn: (id: string) => API.delete(`/admin/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });

  const diskPct = stats?.diskTotalMb
    ? Math.round(((stats.diskUsedMb ?? 0) / stats.diskTotalMb) * 100)
    : 0;

  return (
    <Layout>
      <div className="mx-auto max-w-6xl p-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Admin</h1>
            <p className="text-sm text-text-muted">Manage users, quotas, and system resources</p>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard icon={<Users size={16} />} label="Users" value={stats?.totalUsers ?? "-"} />
          <StatCard icon={<Activity size={16} />} label="Workspaces" value={`${stats?.runningWorkspaces ?? 0}/${stats?.totalWorkspaces ?? 0}`} sub="running / total" />
          <StatCard icon={<Cpu size={16} />} label="CPU" value={`${stats?.cpuPercent?.toFixed(0) ?? 0}%`} />
          <StatCard
            icon={<HardDrive size={16} />}
            label={stats?.diskTotalMb ? `Disk ${diskPct}%` : "Memory"}
            value={
              stats?.diskTotalMb
                ? `${((stats.diskUsedMb ?? 0) / 1024).toFixed(1)}G`
                : `${((stats?.memUsedMb ?? 0) / 1024).toFixed(1)}G`
            }
            sub={
              stats?.diskTotalMb
                ? `/ ${((stats.diskTotalMb ?? 0) / 1024).toFixed(0)}G`
                : `/ ${((stats?.memTotalMb ?? 0) / 1024).toFixed(0)}G`
            }
          />
        </div>

        {/* Tabs row — keeps the existing Users + AI keys panes available
            and adds two read-only audit views without restructuring the page. */}
        <div className="mb-4 flex items-center gap-1 border-b border-bg-border">
          <TabButton active={tab === "users"} onClick={() => setTab("users")} icon={<Users size={14} />}>Users</TabButton>
          <TabButton active={tab === "audit"} onClick={() => setTab("audit")} icon={<ScrollText size={14} />}>Audit log</TabButton>
          <TabButton active={tab === "logins"} onClick={() => setTab("logins")} icon={<LogIn size={14} />}>Login attempts</TabButton>
          <TabButton active={tab === "backup"} onClick={() => setTab("backup")} icon={<Cloud size={14} />}>Backup</TabButton>
          <TabButton active={tab === "semantic"} onClick={() => setTab("semantic")} icon={<Search size={14} />}>AI Search</TabButton>
          <TabButton active={tab === "vpsfiles"} onClick={() => setTab("vpsfiles")} icon={<Server size={14} />}>VPS Files</TabButton>
        </div>

        {tab === "audit" && <AuditLogSection />}
        {tab === "logins" && <LoginAttemptsSection />}
        {tab === "backup" && <BackupSection />}
        {tab === "semantic" && <SemanticSearchSection />}
        {tab === "vpsfiles" && <VFSSection />}

        {tab === "users" && (
        <>
        <section className="card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Users</h2>
            <button className="btn-primary" onClick={() => setShowAdd(true)}>
              <Plus size={14} /> Add user
            </button>
          </div>

          {lu ? (
            <div className="flex items-center gap-2 text-text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="py-2">User</th>
                    <th>Role</th>
                    <th>Workspaces</th>
                    <th>RAM</th>
                    <th>Disk</th>
                    <th>CPU</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {users?.users.map((u) => (
                    <tr key={u.id} className="border-t border-bg-border">
                      <td className="py-3">
                        <div className="font-medium">{u.username}</div>
                        <div className="text-xs text-text-muted">{u.email}</div>
                      </td>
                      <td>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${u.role === "admin" ? "bg-accent/20 text-accent" : "bg-bg-hover text-text-muted"}`}>
                          {u.role}
                        </span>
                      </td>
                      <td>{u.workspaceCount ?? 0} / {u.maxWorkspaces}</td>
                      <td>{u.quotaMemMb} MB</td>
                      <td>{u.quotaDiskMb} MB</td>
                      <td>{u.quotaCpu}</td>
                      <td className="text-right">
                        {u.role !== "admin" && (
                          <button
                            className="btn-ghost text-danger hover:text-danger"
                            onClick={async () => {
                              const ok = await confirm({
                                title: "Delete user?",
                                message: `User ${u.username} and all their workspaces will be removed.`,
                                confirmLabel: "Delete",
                                danger: true,
                              });
                              if (ok) del.mutate(u.id);
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card mt-6 p-6">
          <div className="mb-4 flex items-center gap-2">
            <Key size={16} className="text-accent" />
            <h2 className="font-semibold">AI provider keys</h2>
            <span className="ml-auto text-xs text-text-muted">
              Stored encrypted in DB. Empty value falls back to environment.
            </span>
          </div>
          <AIKeysSection />
        </section>
        </>
        )}
      </div>

      {showAdd && <AddUserModal onClose={() => setShowAdd(false)} />}
      {dialog}
    </Layout>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-t-md px-3 py-2 text-sm transition ${
        active
          ? "border-b-2 border-accent bg-bg-subtle/50 font-medium text-accent"
          : "text-text-muted hover:text-text-default"
      }`}
    >
      {icon} {children}
    </button>
  );
}

type AuditRow = {
  id: string;
  actor_username: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  meta: string | null;
  created_at: number;
};

function AuditLogSection() {
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "audit-log", action, actor],
    queryFn: () => API.get<{ rows: AuditRow[] }>(
      `/admin/audit-log?limit=200${action ? `&action=${encodeURIComponent(action)}` : ""}${actor ? `&actor=${encodeURIComponent(actor)}` : ""}`,
    ),
    refetchInterval: 15000,
  });
  return (
    <section className="card p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Shield size={16} className="text-accent" />
        <h2 className="font-semibold">Security audit log</h2>
        <span className="ml-auto flex gap-2">
          <input
            className="input h-8 text-xs"
            placeholder="filter action…"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          />
          <input
            className="input h-8 text-xs"
            placeholder="filter actor…"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          />
        </span>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : !data?.rows.length ? (
        <div className="text-sm text-text-muted">No events.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left uppercase tracking-wide text-text-muted">
              <tr>
                <th className="py-2">When</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Target</th>
                <th>IP</th>
                <th>Meta</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="border-t border-bg-border">
                  <td className="py-2 text-text-muted">{new Date(r.created_at).toLocaleString()}</td>
                  <td><span className="rounded-full bg-bg-hover px-2 py-0.5 font-mono">{r.action}</span></td>
                  <td>{r.actor_username ?? <span className="text-text-muted">—</span>}</td>
                  <td className="font-mono">{r.target ?? "—"}</td>
                  <td className="font-mono text-text-muted">{r.ip ?? "—"}</td>
                  <td className="max-w-xs truncate font-mono text-[10px] text-text-muted" title={r.meta ?? ""}>{r.meta ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type LoginAttempt = {
  id: number;
  ip: string;
  username: string | null;
  ok: number;
  reason: string | null;
  ua: string | null;
  created_at: number;
};

function LoginAttemptsSection() {
  const [onlyFails, setOnlyFails] = useState(true);
  const [ip, setIp] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "login-attempts", onlyFails, ip],
    queryFn: () => API.get<{ rows: LoginAttempt[]; topFails: { ip: string; fails: number }[] }>(
      `/admin/login-attempts?limit=200${onlyFails ? "&onlyFails=1" : ""}${ip ? `&ip=${encodeURIComponent(ip)}` : ""}`,
    ),
    refetchInterval: 15000,
  });
  return (
    <section className="card p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <LogIn size={16} className="text-accent" />
        <h2 className="font-semibold">Login attempts</h2>
        <label className="ml-4 flex items-center gap-1.5 text-xs text-text-muted">
          <input type="checkbox" checked={onlyFails} onChange={(e) => setOnlyFails(e.target.checked)} />
          Failures only
        </label>
        <input
          className="input ml-auto h-8 w-44 text-xs"
          placeholder="filter IP…"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
        />
      </div>
      {data?.topFails && data.topFails.length > 0 && (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3">
          <div className="mb-1 text-xs font-semibold text-warning">Top failed-login IPs (24h)</div>
          <div className="flex flex-wrap gap-2 text-xs">
            {data.topFails.map((t) => (
              <span key={t.ip} className="rounded-full bg-bg-hover px-2 py-0.5 font-mono">
                {t.ip} <span className="text-warning">×{t.fails}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {isLoading ? (
        <div className="flex items-center gap-2 text-text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : !data?.rows.length ? (
        <div className="text-sm text-text-muted">No attempts.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left uppercase tracking-wide text-text-muted">
              <tr>
                <th className="py-2">When</th>
                <th>Result</th>
                <th>IP</th>
                <th>Username</th>
                <th>Reason</th>
                <th>UA</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="border-t border-bg-border">
                  <td className="py-2 text-text-muted">{new Date(r.created_at).toLocaleString()}</td>
                  <td>
                    {r.ok ? (
                      <span className="rounded-full bg-success/15 px-2 py-0.5 font-semibold text-success">OK</span>
                    ) : (
                      <span className="rounded-full bg-danger/15 px-2 py-0.5 font-semibold text-danger">FAIL</span>
                    )}
                  </td>
                  <td className="font-mono">{r.ip}</td>
                  <td>{r.username ?? <span className="text-text-muted">—</span>}</td>
                  <td className="text-text-muted">{r.reason ?? "—"}</td>
                  <td className="max-w-xs truncate font-mono text-[10px] text-text-muted" title={r.ua ?? ""}>{r.ua ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AIKeysSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "ai-keys"],
    queryFn: () => API.get<{ keys: AIKeyRow[]; encryptionWeak: boolean }>("/admin/ai-keys"),
  });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  return (
    <div className="space-y-2">
      {data?.encryptionWeak && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          Warning: JWT_SECRET uses a default/weak value. AI keys stored in the DB can be decrypted by anyone with the database file. Set a strong JWT_SECRET (32+ random chars) in your environment and restart the server.
        </div>
      )}
      {data?.keys.map((k) => (
        <AIKeyRowEditor
          key={k.provider}
          row={k}
          onSaved={() => qc.invalidateQueries({ queryKey: ["admin", "ai-keys"] })}
        />
      ))}
    </div>
  );
}

function AIKeyRowEditor({ row, onSaved }: { row: AIKeyRow; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await API.put("/admin/ai-keys", { provider: row.provider, value });
      setValue("");
      setEditing(false);
      onSaved();
    } catch (e: any) {
      setErr(e.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function clearKey() {
    setBusy(true);
    setErr("");
    try {
      await API.put("/admin/ai-keys", { provider: row.provider, value: "" });
      setValue("");
      setEditing(false);
      onSaved();
    } catch (e: any) {
      setErr(e.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-bg-border bg-bg-subtle/40 p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-[120px] font-medium">{PROVIDER_LABEL[row.provider]}</div>
        <div className="flex-1 font-mono text-xs text-text-muted">
          {row.configured ? row.masked : <span className="italic">not set</span>}
        </div>
        {row.keyCount > 1 && (
          <span
            className="rounded-full bg-info/15 px-2 py-0.5 text-[10px] uppercase text-info"
            title={`Failover chain — ${row.keyCount} keys. AI will try Key #1 first; on rate-limit / 401, automatically rotate to #2, #3, etc.`}
          >
            {row.keyCount} keys
          </span>
        )}
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${
            row.source === "db"
              ? "bg-success/15 text-success"
              : row.source === "env"
              ? "bg-warning/15 text-warning"
              : "bg-bg-hover text-text-muted"
          }`}
        >
          {row.source}
        </span>
        {!editing && (
          <button className="btn-secondary text-xs" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {row.keyCount > 1 && !editing && (
        <div className="mt-2 ml-[132px] space-y-0.5 font-mono text-[10px] text-text-muted">
          {row.maskedAll.map((m, i) => (
            <div key={i}>
              <span className="opacity-60">Key #{i + 1}:</span> {m}
            </div>
          ))}
        </div>
      )}
      {editing && (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <input
              type={show ? "text" : "password"}
              className="input flex-1 font-mono text-sm"
              placeholder={`Paste ${PROVIDER_LABEL[row.provider]} API key — pisahkan dengan koma untuk failover (apikey1,apikey2,apikey3)`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setShow((s) => !s)}
              title={show ? "Hide" : "Show"}
            >
              {show ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <div className="text-[11px] text-text-muted">
            <span className="font-medium">Multi-key failover:</span> tempel beberapa API key dipisah <code className="rounded bg-bg-hover px-1 font-mono">,</code> (atau <code className="rounded bg-bg-hover px-1 font-mono">;</code> / newline). AI coba Key #1 dulu; kalau kena rate-limit (429) atau auth error (401/403), otomatis rotate ke Key #2, #3, dst. Hemat saat free-tier kuota habis.
          </div>
          {err && <div className="text-xs text-danger">{err}</div>}
          <div className="flex gap-2">
            <button
              className="btn-primary text-xs"
              disabled={busy || !value}
              onClick={save}
            >
              <Save size={12} /> Save
            </button>
            <button
              className="btn-ghost text-xs text-danger"
              disabled={busy}
              onClick={clearKey}
            >
              <Trash2 size={12} /> Remove
            </button>
            <button
              className="btn-ghost text-xs"
              disabled={busy}
              onClick={() => { setEditing(false); setValue(""); setErr(""); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, sub }: any) {
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-text-muted">
        {icon} {label}
      </div>
      <div className="text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-1 text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

function AddUserModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    username: "",
    email: "",
    password: "",
    role: "user",
    quotaCpu: 1,
    quotaMemMb: 2048,
    quotaDiskMb: 10240,
    maxWorkspaces: 3,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await API.post("/admin/users", form);
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      onClose();
    } catch (e: any) {
      setErr(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <form className="card w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="mb-4 text-lg font-semibold">Add user</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="label">Username</label>
            <input className="input" required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </div>
          <div className="col-span-2">
            <label className="label">Email</label>
            <input type="email" className="input" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="col-span-2">
            <label className="label">Password</label>
            <input type="password" className="input" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <div>
            <label className="label">Role</label>
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div>
            <label className="label">Max workspaces</label>
            <input type="number" min={1} className="input" value={form.maxWorkspaces} onChange={(e) => setForm({ ...form, maxWorkspaces: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">CPU cores</label>
            <input type="number" min={0.25} step={0.25} className="input" value={form.quotaCpu} onChange={(e) => setForm({ ...form, quotaCpu: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">RAM (MB)</label>
            <input type="number" min={128} className="input" value={form.quotaMemMb} onChange={(e) => setForm({ ...form, quotaMemMb: Number(e.target.value) })} />
          </div>
          <div className="col-span-2">
            <label className="label">Disk (MB)</label>
            <input type="number" min={512} className="input" value={form.quotaDiskMb} onChange={(e) => setForm({ ...form, quotaDiskMb: Number(e.target.value) })} />
          </div>
        </div>
        {err && <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{err}</div>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />} Create
          </button>
        </div>
      </form>
    </div>
  );
}

// ===========================================================================
// BackupSection — /admin → Backup tab.
//
// Lists snapshots in R2, lets the operator trigger a backup, refresh the
// index, or restore a snapshot. All long-running operations execute on the
// HOST (the API container has no docker/mysql/rclone), so we use a "trigger
// file" bridge: API drops a file in /var/lib/premdev/triggers/, a host cron
// picks it up, writes a result file, we poll for it.
//
// Restore is destructive — guarded by a typed-confirmation modal that
// requires the operator to type the snapshot path verbatim.
// ===========================================================================
type Snapshot = {
  prefix: "daily" | "weekly";
  name: string;
  path: string;
  modTime: string;
  sizeBytes: number;
  fileCount: number;
};
type BackupJob = {
  action: "backup" | "restore" | "refresh-index";
  jobId: string;
  state: "queued" | "running" | "done";
  status?: "ok" | "error";
  exitCode?: number;
  startedAt?: number;
  finishedAt?: number;
  durationSec?: number;
  output?: string;
};
type BackupIndex = {
  configured: boolean;
  snapshots: Snapshot[];
  updatedAt?: number;
  jobs?: BackupJob[];
  reason?: string;
  errors?: string[];
};

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtAgo(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function BackupSection() {
  const qc = useQueryClient();
  const [restoreTarget, setRestoreTarget] = useState<Snapshot | null>(null);
  // Auto-refresh while a job is running so the operator sees progress.
  const { data, isLoading } = useQuery<BackupIndex>({
    queryKey: ["admin", "backups"],
    queryFn: () => API.get<BackupIndex>("/admin/backups"),
    refetchInterval: (q) => {
      const d = q.state.data;
      const live = d?.jobs?.some((j) => j.state === "queued" || j.state === "running");
      return live ? 3000 : 30000;
    },
  });
  const runBackup = useMutation({
    mutationFn: () => API.post("/admin/backups/run", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "backups"] }),
  });
  const refreshIdx = useMutation({
    mutationFn: () => API.post("/admin/backups/refresh", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "backups"] }),
  });

  if (isLoading) {
    return <section className="card p-6"><Loader2 className="animate-spin inline mr-2" size={14} />Loading backups…</section>;
  }

  const snaps = data?.snapshots ?? [];
  const jobs = data?.jobs ?? [];
  const daily  = snaps.filter((s) => s.prefix === "daily");
  const weekly = snaps.filter((s) => s.prefix === "weekly");

  return (
    <>
      <section className="card p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold flex items-center gap-2"><Cloud size={16} /> R2 Backups</h2>
            <p className="text-xs text-text-muted mt-1">
              Snapshots from <code>backup.sh</code> on the host. Index{" "}
              {data?.updatedAt ? <>updated <strong>{fmtAgo(data.updatedAt * 1000)}</strong></> : "not yet built"}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn-secondary"
              disabled={refreshIdx.isPending}
              onClick={() => refreshIdx.mutate()}
              title="Re-list R2 — picks up snapshots created/purged outside the UI"
            >
              {refreshIdx.isPending
                ? <Loader2 size={14} className="animate-spin" />
                : <RefreshCw size={14} />}
              Refresh
            </button>
            <button
              className="btn-primary"
              disabled={runBackup.isPending || !data?.configured}
              onClick={() => runBackup.mutate()}
              title={data?.configured
                ? "Run /usr/local/sbin/premdev-backup on the host now"
                : "R2 not configured — check R2_BUCKET / RCLONE config on host"}
            >
              {runBackup.isPending
                ? <Loader2 size={14} className="animate-spin" />
                : <Play size={14} />}
              Run backup now
            </button>
          </div>
        </div>

        {!data?.configured && (
          <div className="mb-4 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            <strong>R2 not configured.</strong> {data?.reason ?? "Set R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY, R2_SECRET_KEY in /etc/premdev/backup.env on the host, then re-run install.sh or restart the bot."}
          </div>
        )}
        {!!data?.errors?.length && (
          <div className="mb-4 rounded border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
            <strong>Index errors:</strong>
            <ul className="mt-1 list-disc pl-5">
              {data.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        )}

        <SnapshotTable
          title={`Daily (${daily.length})`}
          rows={daily}
          onRestore={setRestoreTarget}
        />
        <SnapshotTable
          title={`Weekly (${weekly.length})`}
          rows={weekly}
          onRestore={setRestoreTarget}
        />
      </section>

      <SystemMaintenanceSection />

      <section className="card p-6 mt-4">
        <h3 className="font-semibold flex items-center gap-2 mb-3">
          <ScrollText size={14} /> Recent jobs
        </h3>
        {jobs.length === 0 ? (
          <p className="text-xs text-text-muted">No recent backup/restore jobs.</p>
        ) : (
          <div className="space-y-2">
            {jobs.map((j) => <JobRow key={j.jobId} job={j} />)}
          </div>
        )}
      </section>

      {restoreTarget && (
        <RestoreModal
          snapshot={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onDone={() => {
            setRestoreTarget(null);
            qc.invalidateQueries({ queryKey: ["admin", "backups"] });
          }}
        />
      )}
    </>
  );
}

function SnapshotTable({ title, rows, onRestore }: {
  title: string; rows: Snapshot[]; onRestore: (s: Snapshot) => void;
}) {
  return (
    <div className="mb-5 last:mb-0">
      <div className="mb-2 text-xs uppercase tracking-wide text-text-muted">{title}</div>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted italic">— none —</p>
      ) : (
        <div className="overflow-x-auto rounded border border-bg-border">
          <table className="w-full text-xs">
            <thead className="bg-bg-soft text-text-muted">
              <tr>
                <th className="text-left p-2">Snapshot</th>
                <th className="text-left p-2">When</th>
                <th className="text-right p-2">Size</th>
                <th className="text-right p-2">Files</th>
                <th className="text-right p-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.path} className="border-t border-bg-border">
                  <td className="p-2 font-mono">{s.path}</td>
                  <td className="p-2">{s.modTime ? new Date(s.modTime).toLocaleString() : "—"}</td>
                  <td className="p-2 text-right">{fmtBytes(s.sizeBytes)}</td>
                  <td className="p-2 text-right">{s.fileCount}</td>
                  <td className="p-2 text-right">
                    <button
                      className="btn-secondary !py-1 !px-2 text-rose-300 hover:!bg-rose-500/10"
                      onClick={() => onRestore(s)}
                      title="Restore this snapshot — DESTRUCTIVE"
                    >
                      <Download size={12} /> Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// System maintenance — manual Docker cleanup trigger. Daily cron on the host
// runs the same script automatically; this button lets the admin force a run
// (e.g. when /admin shows disk pressure on the topbar gauge).
function SystemMaintenanceSection() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const cleanup = useMutation({
    mutationFn: () => API.post<{ ok: boolean; jobId: string }>("/admin/system/cleanup", {}),
    onSettled: () => {
      // Refresh the backups query so the new job shows up in "Recent jobs".
      qc.invalidateQueries({ queryKey: ["admin", "backups"] });
    },
  });
  return (
    <section className="card p-6 mt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <Sparkles size={16} /> System maintenance
          </h3>
          <p className="text-xs text-text-muted mt-1">
            Bersihin Docker images, build cache, container mati, dan volume nganggur.
            Cron harian jam 03:00 WIB juga otomatis menjalankan ini.
            Container PremDev yang aktif tidak terganggu.
          </p>
        </div>
        <button
          className="btn-primary"
          disabled={cleanup.isPending}
          onClick={async () => {
            const ok = await confirm({
              title: "Bersihkan Docker sekarang?",
              message:
                "Akan menghapus image yang tidak dipakai, build cache, dan volume nganggur. Container yang sedang jalan tetap aman. Hasil muncul di 'Recent jobs' di bawah.",
              confirmLabel: "Bersihkan",
            });
            if (ok) cleanup.mutate();
          }}
          title="Run /usr/local/sbin/premdev-docker-cleanup on the host now"
        >
          {cleanup.isPending
            ? <Loader2 size={14} className="animate-spin" />
            : <Trash2 size={14} />}
          Clear Docker cache
        </button>
      </div>
      {cleanup.isSuccess && (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-200">
          Cleanup queued (job <code>{cleanup.data?.jobId}</code>). Hasil ada di Recent jobs di bawah.
        </div>
      )}
      {cleanup.isError && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
          {(cleanup.error as any)?.message ?? "Cleanup failed to queue"}
        </div>
      )}
      {dialog}
    </section>
  );
}

function JobRow({ job }: { job: BackupJob }) {
  const colour = job.state === "done"
    ? (job.status === "ok" ? "text-emerald-400" : "text-rose-400")
    : "text-amber-300";
  return (
    <details className="rounded border border-bg-border bg-bg-soft text-xs">
      <summary className="cursor-pointer p-2 flex items-center gap-2">
        <span className={`font-mono ${colour}`}>
          {job.state === "running" && <Loader2 size={12} className="inline animate-spin mr-1" />}
          {job.action}
        </span>
        <span className="text-text-muted">#{job.jobId}</span>
        <span className="ml-auto text-text-muted">
          {job.state === "done"
            ? `${job.status} · ${job.durationSec ?? 0}s · ${job.finishedAt ? fmtAgo(job.finishedAt * 1000) : ""}`
            : job.state}
        </span>
      </summary>
      {job.output && (
        <pre className="px-3 pb-3 text-[11px] whitespace-pre-wrap text-text-muted max-h-60 overflow-auto">
          {job.output}
        </pre>
      )}
    </details>
  );
}

function RestoreModal({ snapshot, onClose, onDone }: {
  snapshot: Snapshot; onClose: () => void; onDone: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const restore = useMutation({
    mutationFn: () => API.post("/admin/backups/restore", { snapshot: snapshot.path, confirm: typed }),
    onSuccess: onDone,
    onError: (e: any) => setErr(e?.message ?? "Restore failed"),
  });
  const matches = typed === snapshot.path;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="card w-full max-w-lg p-5">
        <div className="mb-3 flex items-center gap-2 text-rose-300">
          <AlertTriangle size={18} />
          <h3 className="font-semibold">Restore snapshot — DESTRUCTIVE</h3>
        </div>
        <p className="text-sm text-text-muted">
          This will <strong>stop the app</strong>, replace the SQLite database,
          drop & re-import all MySQL databases, and overwrite{" "}
          <code>workspaces/</code> with the snapshot contents.
          A pre-restore safety dump is written to{" "}
          <code className="text-xs">/var/backups/premdev-pre-restore-…</code> on
          the host.
        </p>
        <div className="my-4 rounded border border-bg-border bg-bg-soft p-3 text-xs">
          <div><strong>Snapshot:</strong> <span className="font-mono">{snapshot.path}</span></div>
          <div><strong>Size:</strong> {fmtBytes(snapshot.sizeBytes)} ({snapshot.fileCount} files)</div>
          <div><strong>Created:</strong> {snapshot.modTime ? new Date(snapshot.modTime).toLocaleString() : "—"}</div>
        </div>
        <label className="block text-xs">
          To confirm, type the snapshot path exactly:{" "}
          <code className="text-rose-300">{snapshot.path}</code>
          <input
            autoFocus
            className="input mt-1 w-full font-mono"
            value={typed}
            onChange={(e) => { setTyped(e.target.value); setErr(null); }}
            placeholder={snapshot.path}
          />
        </label>
        {err && <div className="mt-2 text-xs text-rose-300">{err}</div>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={restore.isPending}>Cancel</button>
          <button
            className="btn-primary !bg-rose-500 hover:!bg-rose-600"
            disabled={!matches || restore.isPending}
            onClick={() => restore.mutate()}
          >
            {restore.isPending && <Loader2 size={14} className="animate-spin" />}
            Restore
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SemanticSearchSection — admin tab for the lumen-style code search feature.
//
// Shows: model load status, RAM, totals across workspaces, and a per-workspace
// table with manual reindex / clear controls. Polls /admin/semantic-search/status
// every 5s so "loading" → "ready" transitions are visible without refresh.
// ---------------------------------------------------------------------------

type EmbeddingStatus = {
  enabled: boolean;
  status: "idle" | "loading" | "ready" | "error";
  model: string;
  dim: number;
  loadedAt: number | null;
  error: string | null;
  rssBytes: number | null;
};

type WorkspaceIndexRow = {
  id: string;
  name: string;
  username: string | null;
  exists: boolean;
  chunks: number;
  files: number;
  lastIndexedMs: number | null;
  dbBytes: number;
};

type SemanticStatusResponse = {
  model: EmbeddingStatus;
  workspaces: WorkspaceIndexRow[];
  totals: { chunks: number; files: number; dbBytes: number; indexed: number; totalWorkspaces: number };
};

function SemanticSearchSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "semantic-search"],
    queryFn: () => API.get<SemanticStatusResponse>("/admin/semantic-search/status"),
    // 3s poll while loading is fast enough to feel responsive but not
    // hammer the API; bump to 10s once ready (status rarely changes).
    refetchInterval: (q) => (q.state.data?.model.status === "loading" ? 3000 : 10000),
  });

  const preload = useMutation({
    mutationFn: () => API.post("/admin/semantic-search/preload", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "semantic-search"] }),
  });

  const reindex = useMutation({
    mutationFn: (workspaceId: string) =>
      API.post<{ ok: boolean; scanned: number; indexed: number; reused: number; chunks: number; durationMs: number }>(
        `/admin/semantic-search/reindex/${workspaceId}`, {}
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "semantic-search"] }),
  });

  const clearIndex = useMutation({
    mutationFn: (workspaceId: string) => API.delete(`/admin/semantic-search/index/${workspaceId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "semantic-search"] }),
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 text-text-muted">
        <Loader2 size={14} className="animate-spin" /> Loading semantic search status…
      </div>
    );
  }

  const { model, workspaces, totals } = data;

  // Status pill — colour by state.
  const statusPill = (() => {
    if (!model.enabled) return { label: "DISABLED", cls: "bg-bg-subtle text-text-muted border-bg-border" };
    if (model.status === "ready") return { label: "READY", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" };
    if (model.status === "loading") return { label: "LOADING", cls: "bg-amber-500/15 text-amber-300 border-amber-500/40" };
    if (model.status === "error") return { label: "ERROR", cls: "bg-rose-500/15 text-rose-300 border-rose-500/40" };
    return { label: "IDLE", cls: "bg-bg-subtle text-text-muted border-bg-border" };
  })();

  return (
    <div className="space-y-4">
      {/* Header card: model state + global totals */}
      <section className="card p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 font-semibold">
              <Sparkles size={16} /> AI semantic search
              <span className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${statusPill.cls}`}>
                {statusPill.label}
              </span>
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              Index lokal kode user pakai embedding model untuk kurangin token AI sampai ~70%. Otomatis index pas user
              chat pertama kali di workspace; di-re-index kalau file mtime berubah.
            </p>
          </div>
          {model.enabled && model.status !== "ready" && model.status !== "loading" && (
            <button
              className="btn-secondary"
              onClick={() => preload.mutate()}
              disabled={preload.isPending}
              title="Load model sekarang biar chat pertama gak nunggu ~30s download"
            >
              {preload.isPending ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              Preload model
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs lg:grid-cols-4">
          <SemStat label="Model" value={model.model.split("/").pop() || model.model} sub={`${model.dim}-dim`} />
          <SemStat
            label="API process RAM"
            value={model.rssBytes ? `${(model.rssBytes / (1024 * 1024)).toFixed(0)} MB` : "—"}
            sub={model.loadedAt ? `model loaded ${fmtAgo(model.loadedAt)}` : "model not loaded"}
          />
          <SemStat
            label="Workspaces indexed"
            value={`${totals.indexed} / ${totals.totalWorkspaces}`}
            sub={totals.totalWorkspaces ? `${Math.round((totals.indexed / totals.totalWorkspaces) * 100)}% covered` : "no workspaces"}
          />
          <SemStat
            label="Total chunks"
            value={totals.chunks.toLocaleString()}
            sub={`${totals.files.toLocaleString()} files · ${(totals.dbBytes / (1024 * 1024)).toFixed(1)} MB on disk`}
          />
        </div>

        {model.error && (
          <div className="mt-3 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
            <div className="flex items-center gap-1 font-semibold">
              <AlertTriangle size={12} /> Model error
            </div>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{model.error}</pre>
          </div>
        )}
      </section>

      {/* Per-workspace table */}
      <section className="card p-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">Per-workspace index</h3>
          <button
            className="btn-secondary"
            onClick={() => qc.invalidateQueries({ queryKey: ["admin", "semantic-search"] })}
            title="Refresh stats"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {workspaces.length === 0 ? (
          <div className="text-sm text-text-muted">Belum ada workspace.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
                <tr className="border-b border-bg-border">
                  <th className="py-2 pr-3">User / Workspace</th>
                  <th className="py-2 pr-3">Files</th>
                  <th className="py-2 pr-3">Chunks</th>
                  <th className="py-2 pr-3">Size</th>
                  <th className="py-2 pr-3">Last indexed</th>
                  <th className="py-2 pr-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {workspaces.map((w) => {
                  const isReindexing = reindex.isPending && reindex.variables === w.id;
                  const isClearing = clearIndex.isPending && clearIndex.variables === w.id;
                  return (
                    <tr key={w.id} className="border-b border-bg-border/50 last:border-0">
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-1">
                          <span className="text-text-muted">{w.username || "?"}</span>
                          <span className="text-text-muted">/</span>
                          <span className="font-medium">{w.name}</span>
                        </div>
                        <div className="font-mono text-[10px] text-text-muted">{w.id}</div>
                      </td>
                      <td className="py-2 pr-3">{w.files || (w.exists ? <span className="text-text-muted">0</span> : <span className="text-text-muted">—</span>)}</td>
                      <td className="py-2 pr-3">{w.chunks || (w.exists ? <span className="text-text-muted">0</span> : <span className="text-text-muted">—</span>)}</td>
                      <td className="py-2 pr-3">
                        {w.dbBytes > 0
                          ? w.dbBytes < 1024
                            ? `${w.dbBytes} B`
                            : w.dbBytes < 1024 * 1024
                              ? `${(w.dbBytes / 1024).toFixed(0)} KB`
                              : `${(w.dbBytes / (1024 * 1024)).toFixed(1)} MB`
                          : <span className="text-text-muted">—</span>}
                      </td>
                      <td className="py-2 pr-3 text-text-muted">
                        {w.lastIndexedMs ? fmtAgo(w.lastIndexedMs) : <span className="italic">never</span>}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <div className="inline-flex gap-1">
                          <button
                            className="btn-secondary !px-2 !py-1 text-xs"
                            onClick={() => reindex.mutate(w.id)}
                            disabled={isReindexing || !model.enabled}
                            title="Scan files & rebuild stale chunks (gak ngulang yg mtime-nya sama)"
                          >
                            {isReindexing ? <Loader2 size={12} className="animate-spin" /> : <Database size={12} />}
                            {isReindexing ? "Indexing…" : "Reindex"}
                          </button>
                          {w.exists && (
                            <button
                              className="btn-secondary !px-2 !py-1 text-xs !text-rose-300"
                              onClick={() => clearIndex.mutate(w.id)}
                              disabled={isClearing}
                              title="Hapus index workspace ini sepenuhnya — chat berikutnya bakal trigger reindex full"
                            >
                              {isClearing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                              Clear
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {reindex.isError && (
          <div className="mt-3 text-xs text-rose-300">
            Reindex gagal: {(reindex.error as any)?.message || "unknown error"}
          </div>
        )}
      </section>
    </div>
  );
}

function SemStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-bg-border bg-bg-subtle p-3">
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-0.5 truncate font-mono text-sm">{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-text-muted">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// VFS Section — VPS Filesystem Browser
// ---------------------------------------------------------------------------

type VfsItem = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

type VfsListResponse = { path: string; items: VfsItem[] };
type VfsReadResponse = {
  path: string;
  size: number;
  binary: boolean;
  content: string | null;
  error?: string;
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function VFSSection() {
  const [currentPath, setCurrentPath] = useState("/");
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>(["/"]);
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);

  const listQ = useQuery<VfsListResponse>({
    queryKey: ["vfs", "list", currentPath],
    queryFn: () => API.get(`/vfs/list?path=${encodeURIComponent(currentPath)}`),
    retry: false,
  });

  function navigate(path: string) {
    setCurrentPath(path);
    // Rebuild breadcrumbs from path
    const parts = path.split("/").filter(Boolean);
    setBreadcrumbs(["/" , ...parts.map((_, i) => "/" + parts.slice(0, i + 1).join("/"))]);
    setOpenFile(null);
  }

  async function openFileAt(path: string) {
    setOpenFile(null);
    setEditContent("");
    setSaveError(null);
    setSaveOk(false);
    try {
      const res: VfsReadResponse = await API.get(`/vfs/read?path=${encodeURIComponent(path)}`);
      if (res.binary) {
        setOpenFile({ path, content: "[Binary file — tidak bisa diedit di browser]" });
        setEditContent("[Binary file — tidak bisa diedit di browser]");
      } else if (res.error) {
        setOpenFile({ path, content: `[Error: ${res.error}]` });
        setEditContent(`[Error: ${res.error}]`);
      } else {
        setOpenFile({ path, content: res.content ?? "" });
        setEditContent(res.content ?? "");
      }
    } catch (e: any) {
      setOpenFile({ path, content: `[Error membaca file: ${e.message}]` });
      setEditContent(`[Error membaca file: ${e.message}]`);
    }
  }

  async function saveFile() {
    if (!openFile) return;
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      await API.post("/vfs/write", { path: openFile.path, content: editContent });
      setSaveOk(true);
      setOpenFile({ ...openFile, content: editContent });
      setTimeout(() => setSaveOk(false), 3000);
    } catch (e: any) {
      setSaveError(e.message ?? "Gagal menyimpan");
    } finally {
      setSaving(false);
    }
  }

  async function createFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    setCreatingFolder(true);
    try {
      const newPath = currentPath.replace(/\/$/, "") + "/" + name;
      await API.post("/vfs/mkdir", { path: newPath });
      setNewFolderName("");
      setShowNewFolder(false);
      listQ.refetch();
    } catch (e: any) {
      alert(`Gagal buat folder: ${e.message}`);
    } finally {
      setCreatingFolder(false);
    }
  }

  const isBinaryOrError =
    openFile &&
    (openFile.content?.startsWith("[Binary") || openFile.content?.startsWith("[Error"));

  // Breadcrumb labels: "/" = Home, others = folder name
  const breadcrumbLabels = breadcrumbs.map((p, i) =>
    i === 0 ? "/" : p.split("/").filter(Boolean).pop() ?? p,
  );

  return (
    <div className="space-y-4">
      {/* Warning banner */}
      <div className="flex items-start gap-2 rounded border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span>
          <strong>⚠ Akses langsung ke filesystem VPS.</strong> Hati-hati saat mengedit file sistem
          — salah edit <code>/etc</code> bisa bikin VPS tidak bisa boot.
          <br />
          <span className="text-rose-400/80 text-xs mt-1 block">
            Fitur ini butuh volume mount di docker-compose.yml:{" "}
            <code className="bg-rose-900/30 px-1 rounded">- /:/vpsroot:rw</code> pada service{" "}
            <code className="bg-rose-900/30 px-1 rounded">app</code>.
          </span>
        </span>
      </div>

      <section className="card p-0 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b border-bg-border px-4 py-2">
          <button
            className="btn-ghost !p-1"
            onClick={() => navigate("/")}
            title="Root"
          >
            <Home size={14} />
          </button>
          {/* Breadcrumbs */}
          <div className="flex items-center gap-0.5 text-sm overflow-x-auto flex-1">
            {breadcrumbs.map((p, i) => (
              <span key={p} className="flex items-center gap-0.5 shrink-0">
                {i > 0 && <ChevronRight size={12} className="text-text-muted" />}
                <button
                  className={`rounded px-1 py-0.5 hover:bg-bg-hover ${i === breadcrumbs.length - 1 ? "font-medium" : "text-text-muted"}`}
                  onClick={() => navigate(p)}
                >
                  {breadcrumbLabels[i]}
                </button>
              </span>
            ))}
          </div>
          <button
            className="btn-ghost !p-1 shrink-0"
            onClick={() => listQ.refetch()}
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <button
            className="btn-ghost !p-1 shrink-0"
            onClick={() => setShowNewFolder(!showNewFolder)}
            title="Buat folder baru"
          >
            <FolderPlus size={14} />
          </button>
        </div>

        {/* New folder input */}
        {showNewFolder && (
          <div className="flex items-center gap-2 border-b border-bg-border px-4 py-2 bg-bg-subtle">
            <FolderPlus size={14} className="text-text-muted shrink-0" />
            <input
              className="input flex-1 text-sm !py-1"
              placeholder="Nama folder baru…"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createFolder(); if (e.key === "Escape") setShowNewFolder(false); }}
              autoFocus
            />
            <button className="btn-primary !py-1 !px-3 text-xs" onClick={createFolder} disabled={creatingFolder}>
              {creatingFolder ? <Loader2 size={12} className="animate-spin" /> : "Buat"}
            </button>
            <button className="btn-ghost !p-1" onClick={() => setShowNewFolder(false)}><X size={14} /></button>
          </div>
        )}

        <div className="flex divide-x divide-bg-border" style={{ minHeight: "420px" }}>
          {/* File list panel */}
          <div className="w-80 shrink-0 overflow-y-auto">
            {listQ.isLoading && (
              <div className="flex items-center gap-2 p-4 text-text-muted text-sm">
                <Loader2 size={14} className="animate-spin" /> Memuat…
              </div>
            )}
            {listQ.isError && (
              <div className="p-4 text-sm text-rose-300">
                {(listQ.error as any)?.message ?? "Gagal memuat direktori"}
              </div>
            )}
            {listQ.data?.items.length === 0 && (
              <div className="p-4 text-sm text-text-muted italic">Directory kosong</div>
            )}
            {listQ.data?.items.map((item) => (
              <button
                key={item.path}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg-hover text-left ${openFile?.path === item.path ? "bg-bg-hover" : ""}`}
                onClick={() => {
                  if (item.type === "dir") {
                    navigate(item.path);
                  } else {
                    openFileAt(item.path);
                  }
                }}
              >
                {item.type === "dir" ? (
                  <Folder size={14} className="shrink-0 text-accent" />
                ) : (
                  <FileText size={14} className="shrink-0 text-text-muted" />
                )}
                <span className="flex-1 truncate">{item.name}</span>
                {item.type === "file" && (
                  <span className="text-[10px] text-text-muted shrink-0">{fmtSize(item.size)}</span>
                )}
                {item.type === "dir" && (
                  <ChevronRight size={12} className="shrink-0 text-text-muted" />
                )}
              </button>
            ))}
          </div>

          {/* Editor panel */}
          <div className="flex-1 flex flex-col">
            {!openFile && (
              <div className="flex flex-1 items-center justify-center text-text-muted text-sm">
                <div className="text-center">
                  <FilePen size={32} className="mx-auto mb-2 opacity-30" />
                  Pilih file untuk diedit
                </div>
              </div>
            )}
            {openFile && (
              <>
                {/* File header */}
                <div className="flex items-center gap-2 border-b border-bg-border px-4 py-2 text-sm">
                  <FileText size={14} className="shrink-0 text-text-muted" />
                  <span className="flex-1 font-mono text-xs truncate">{openFile.path}</span>
                  {!isBinaryOrError && (
                    <button
                      className="btn-primary !py-1 !px-3 text-xs"
                      onClick={saveFile}
                      disabled={saving}
                    >
                      {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                      {saving ? "Menyimpan…" : "Simpan"}
                    </button>
                  )}
                </div>
                {saveError && (
                  <div className="px-4 py-1.5 text-xs text-rose-300 border-b border-bg-border bg-rose-500/10">
                    ✖ {saveError}
                  </div>
                )}
                {saveOk && (
                  <div className="px-4 py-1.5 text-xs text-emerald-400 border-b border-bg-border bg-emerald-500/10">
                    ✔ File berhasil disimpan
                  </div>
                )}
                <textarea
                  className="flex-1 resize-none bg-transparent px-4 py-3 font-mono text-xs leading-relaxed outline-none"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  readOnly={!!isBinaryOrError}
                  spellCheck={false}
                />
              </>
            )}
          </div>
        </div>
      </section>

      {/* Bookmarks */}
      <section className="card p-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Shortcut path yang sering dipakai
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            "/opt/premdev/.env",
            "/opt/premdev/docker-compose.yml",
            "/etc/caddy/Caddyfile",
            "/opt/premdev/infra/Caddyfile.tmpl",
            "/etc/hostname",
            "/etc/hosts",
          ].map((p) => (
            <button
              key={p}
              className="btn-secondary !py-1 !px-2 text-xs font-mono"
              onClick={() => openFileAt(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

