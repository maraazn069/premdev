import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { API } from "@/lib/api";
import { Layout } from "@/components/Layout";
import { useConfirm } from "@/lib/useConfirm";
import {
  Plus,
  Play,
  Square,
  Trash2,
  ExternalLink,
  Loader2,
  FolderOpen,
} from "lucide-react";

type Workspace = {
  id: string;
  name: string;
  template: string;
  status: "stopped" | "starting" | "running" | "error";
  createdAt: string;
  previewPort?: number;
  previewUrl?: string;
};

const TEMPLATES = [
  { id: "blank", label: "Blank", color: "bg-bg-hover" },
  { id: "node", label: "Node.js", color: "bg-emerald-600" },
  { id: "python", label: "Python", color: "bg-blue-600" },
  { id: "php", label: "PHP", color: "bg-indigo-600" },
  { id: "static", label: "Static HTML", color: "bg-amber-600" },
  { id: "react", label: "React + Vite", color: "bg-cyan-600" },
  { id: "express", label: "Express", color: "bg-emerald-700" },
  { id: "flask", label: "Flask", color: "bg-blue-700" },
  { id: "laravel", label: "Laravel", color: "bg-rose-600" },
  { id: "go", label: "Go", color: "bg-sky-600" },
  { id: "rust", label: "Rust", color: "bg-orange-700" },
  { id: "java", label: "Java", color: "bg-red-700" },
  { id: "cpp", label: "C/C++", color: "bg-slate-600" },
  { id: "ruby", label: "Ruby", color: "bg-red-600" },
  { id: "zip", label: "Upload ZIP", color: "bg-purple-600" },
  { id: "git", label: "Import Git", color: "bg-gray-700" },
];

export default function Dashboard() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [showNew, setShowNew] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => API.get<{ workspaces: Workspace[] }>("/workspaces"),
  });

  const startStop = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "start" | "stop" }) =>
      API.post(`/workspaces/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspaces"] }),
  });

  const del = useMutation({
    mutationFn: (id: string) => API.delete(`/workspaces/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspaces"] }),
  });

  return (
    <Layout>
      <div className="mx-auto max-w-6xl p-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Workspaces</h1>
            <p className="text-sm text-text-muted">
              Your projects, ready to run anywhere
            </p>
          </div>
          <button
            className="btn-primary"
            onClick={() => setShowNew(true)}
          >
            <Plus size={16} /> New workspace
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-text-muted">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        ) : data?.workspaces.length ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.workspaces.map((w) => {
              const tmpl = TEMPLATES.find((t) => t.id === w.template) ?? TEMPLATES[0];
              return (
                <div key={w.id} className="card p-4 transition hover:border-accent/50">
                  <div className="mb-3 flex items-start justify-between">
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-md text-white text-xs font-bold"
                      style={{}}
                    >
                      <span className={`grid h-10 w-10 place-items-center rounded-md text-white text-xs font-bold ${tmpl.color}`}>
                        {tmpl.label.slice(0, 2).toUpperCase()}
                      </span>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${
                        w.status === "running"
                          ? "bg-success/20 text-success"
                          : w.status === "starting"
                          ? "bg-warning/20 text-warning"
                          : w.status === "error"
                          ? "bg-danger/20 text-danger"
                          : "bg-bg-hover text-text-muted"
                      }`}
                    >
                      {w.status}
                    </span>
                  </div>

                  <button
                    className="text-left"
                    onClick={() => nav(`/workspace/${w.id}`)}
                  >
                    <div className="font-semibold">{w.name}</div>
                    <div className="text-xs text-text-muted">{tmpl.label}</div>
                  </button>

                  <div className="mt-4 flex items-center gap-1.5">
                    <button
                      className="btn-secondary flex-1"
                      onClick={() => nav(`/workspace/${w.id}`)}
                    >
                      <FolderOpen size={14} /> Open
                    </button>
                    {w.status === "running" ? (
                      <button
                        className="btn-ghost"
                        title="Stop"
                        onClick={() => startStop.mutate({ id: w.id, action: "stop" })}
                      >
                        <Square size={14} />
                      </button>
                    ) : (
                      <button
                        className="btn-ghost"
                        title="Start"
                        onClick={() => startStop.mutate({ id: w.id, action: "start" })}
                      >
                        <Play size={14} />
                      </button>
                    )}
                    {w.previewUrl && (
                      <a
                        className="btn-ghost"
                        title="Open preview"
                        target="_blank"
                        rel="noreferrer"
                        href={w.previewUrl}
                      >
                        <ExternalLink size={14} />
                      </a>
                    )}
                    <button
                      className="btn-ghost text-danger hover:text-danger"
                      title="Delete"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Hapus workspace?",
                          message: `Workspace "${w.name}" beserta semua filenya akan dihapus permanen. Tidak bisa dikembalikan.`,
                          confirmLabel: "Hapus",
                          cancelLabel: "Batal",
                          danger: true,
                        });
                        if (ok) del.mutate(w.id);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="card p-12 text-center">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-bg-hover text-text-muted">
              <Plus size={20} />
            </div>
            <div className="mb-1 font-medium">No workspaces yet</div>
            <div className="mb-4 text-sm text-text-muted">
              Create your first workspace to start coding
            </div>
            <button className="btn-primary" onClick={() => setShowNew(true)}>
              <Plus size={16} /> New workspace
            </button>
          </div>
        )}
      </div>

      {showNew && <NewWorkspaceModal onClose={() => setShowNew(false)} />}
      {confirmDialog}
    </Layout>
  );
}

function NewWorkspaceModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("blank");
  const [gitUrl, setGitUrl] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      let body: any = { name, template };
      if (template === "git") body.gitUrl = gitUrl;

      let res: any;
      if (template === "zip" && zipFile) {
        const fd = new FormData();
        fd.append("name", name);
        fd.append("file", zipFile);
        const r = await fetch("/api/workspaces/upload", {
          method: "POST",
          body: fd,
          credentials: "include",
        });
        if (!r.ok) throw new Error((await r.text()) || "Upload failed");
        res = await r.json();
      } else {
        res = await API.post<{ workspace: any }>("/workspaces", body);
      }
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      onClose();
      if (res?.workspace?.id) nav(`/workspace/${res.workspace.id}`);
    } catch (e: any) {
      setErr(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <form
        className="card w-full max-w-2xl p-6"
        onClick={(e) => e.stopPropagation()}
        onSubmit={onCreate}
      >
        <h2 className="mb-4 text-lg font-semibold">Create new workspace</h2>

        <div className="mb-4">
          <label className="label">Name</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-awesome-project"
            required
            autoFocus
          />
        </div>

        <div className="mb-4">
          <label className="label">Template</label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {TEMPLATES.map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => setTemplate(t.id)}
                className={`rounded-md border px-3 py-3 text-left text-xs transition ${
                  template === t.id
                    ? "border-accent bg-accent/10"
                    : "border-bg-border bg-bg-subtle hover:border-bg-border"
                }`}
              >
                <div className={`mb-1.5 inline-block rounded px-1.5 py-0.5 text-[9px] font-bold text-white ${t.color}`}>
                  {t.label.slice(0, 3).toUpperCase()}
                </div>
                <div className="font-medium">{t.label}</div>
              </button>
            ))}
          </div>
        </div>

        {template === "git" && (
          <div className="mb-4">
            <label className="label">Git URL</label>
            <input
              className="input"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              required
            />
          </div>
        )}

        {template === "zip" && (
          <div className="mb-4">
            <label className="label">ZIP file</label>
            <input
              type="file"
              accept=".zip"
              className="input"
              onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
              required
            />
          </div>
        )}

        {err && (
          <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {err}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
