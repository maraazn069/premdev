import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  PanelGroup,
  Panel,
  PanelResizeHandle,
} from "react-resizable-panels";
import Editor from "@monaco-editor/react";
import {
  ChevronLeft,
  Play,
  Square,
  Save,
  RefreshCw,
  Sparkles,
  Folder,
  File as FileIcon,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  Plus,
  Trash2,
  Pencil,
  Download,
  History,
  RotateCw,
  Terminal,
  Eye,
  EyeOff,
  Settings,
  Lock,
  Globe,
  Check as CheckIcon,
  AlertTriangle,
  Loader2,
  X,
  Wand2,
  GitBranch,
} from "lucide-react";
import { API } from "@/lib/api";
import { TerminalPane } from "@/components/Terminal";
import { AIChat } from "@/components/AIChat";
import { SecretsPanel } from "@/components/SecretsPanel";
import { useConfirm } from "@/lib/useConfirm";

type Workspace = {
  id: string;
  name: string;
  template: string;
  status: "stopped" | "starting" | "running" | "error";
  previewPort?: number;
  previewUrl?: string;
  // Auto-generated <project>-<user>.<domain> URL — always present so the
  // user can compare the fallback against their custom subdomain.
  defaultUrl?: string;
  customSubdomain?: string | null;
  runCommand?: string | null;
};

type FileNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNode[];
};

type Checkpoint = {
  id: string;
  workspace_id: string;
  message: string;
  size_bytes: number;
  created_at: number;
};

const AUTO_SAVE_DELAY_MS = 1500;

export default function EditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [showAI, setShowAI] = useState(false);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [showSubdomain, setShowSubdomain] = useState(false);
  const [showGit, setShowGit] = useState(false);
  const [showQuickActions, setShowQuickActions] = useState(false);
  // Monaco editor instance — captured in onMount so we can read the active
  // selection from anywhere (Ask AI, quick actions, etc.).
  const editorRef = useRef<any>(null);
  // Mirror activePath into a ref so Monaco's onMount closure (captured once
  // per file open) always reads the latest value when an action runs.
  const activePathRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef({ path: null as string | null, content: "" });
  // Monotonic save generation so stale completions cannot clear newer dirty state.
  const saveGenRef = useRef(0);
  const lastEditGenRef = useRef(0);

  const { data: ws } = useQuery({
    queryKey: ["workspace", id],
    queryFn: () => API.get<{ workspace: Workspace }>(`/workspaces/${id}`),
    refetchInterval: 3000,
  });

  const startStop = useMutation({
    mutationFn: (action: "start" | "stop" | "restart") =>
      API.post(`/workspaces/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspace", id] }),
  });

  async function saveNow(targetPath: string, body: string) {
    const myGen = ++saveGenRef.current;
    const editGenAtStart = lastEditGenRef.current;
    setSavingState("saving");
    try {
      await API.put(`/workspaces/${id}/files`, { path: targetPath, content: body });
      // Only clear dirty if no newer edit happened during this save AND
      // no newer save has been kicked off (avoids stale ack from concurrent saves).
      if (myGen === saveGenRef.current && editGenAtStart === lastEditGenRef.current) {
        setSavingState("saved");
        setDirty(false);
      } else {
        // Newer changes pending; stay dirty so the next debounce/manual save runs.
        setSavingState("idle");
      }
    } catch {
      if (myGen === saveGenRef.current) setSavingState("error");
    }
  }

  // Auto-save with debounce
  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    if (!dirty || !activePath) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    latestRef.current = { path: activePath, content };
    saveTimer.current = setTimeout(() => {
      saveNow(latestRef.current.path!, latestRef.current.content);
    }, AUTO_SAVE_DELAY_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [content, activePath, dirty]);

  // Manual save shortcut
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (saveTimer.current) {
          clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        if (activePath && dirty) saveNow(activePath, content);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePath, dirty, content]);

  const w = ws?.workspace;
  const saveLabel =
    savingState === "saving" ? "Saving…"
    : savingState === "error" ? "Save failed"
    : dirty ? "Modified"
    : "Saved";

  return (
    <div className="flex h-screen flex-col bg-bg">
      <header className="flex items-center gap-2 border-b border-bg-border bg-bg-panel px-3 py-2">
        <button className="btn-ghost" onClick={() => nav("/")}>
          <ChevronLeft size={16} />
        </button>
        <div className="flex items-center gap-2">
          <span className="font-semibold">{w?.name ?? "…"}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${
              w?.status === "running"
                ? "bg-success/20 text-success"
                : w?.status === "starting"
                ? "bg-warning/20 text-warning"
                : w?.status === "error"
                ? "bg-danger/20 text-danger"
                : "bg-bg-hover text-text-muted"
            }`}
          >
            {w?.status ?? "loading"}
          </span>
        </div>
        <div className="flex-1" />
        <span className="hidden text-xs text-text-muted sm:inline">{saveLabel}</span>
        <button
          className="btn-secondary"
          onClick={() => activePath && saveNow(activePath, content)}
          disabled={!dirty || !activePath || savingState === "saving"}
          title="Save (Ctrl+S)"
        >
          <Save size={14} />
        </button>
        <button
          className="btn-secondary"
          title="Checkpoints"
          onClick={() => setShowCheckpoints(true)}
        >
          <History size={14} />
        </button>
        <button
          className="btn-secondary"
          title="Secrets — KEY=value vars injected into your container"
          onClick={() => setShowSecrets(true)}
        >
          <Lock size={14} />
        </button>
        <button
          className="btn-secondary"
          title={
            w?.customSubdomain
              ? `Custom subdomain: ${w.customSubdomain}`
              : "Set a custom subdomain for this workspace"
          }
          onClick={() => setShowSubdomain(true)}
        >
          <Globe size={14} />
          {w?.customSubdomain && (
            <span className="ml-1 hidden text-[10px] text-accent sm:inline">
              {w.customSubdomain}
            </span>
          )}
        </button>
        <button
          className="btn-secondary"
          title="Open .premdev (workspace config: run command, env)"
          onClick={async () => {
            try {
              const r = await API.post<{ path: string }>(
                `/workspaces/${id}/config/init`,
                {},
              );
              // Save any pending edits, refresh tree (so the file shows up
              // when hidden files are visible), then load the file content
              // into Monaco — mirroring the file-tree onSelect flow.
              if (dirty && activePath) {
                if (saveTimer.current) {
                  clearTimeout(saveTimer.current);
                  saveTimer.current = null;
                }
                await saveNow(activePath, content);
              }
              await qc.invalidateQueries({ queryKey: ["files", id] });
              setActivePath(r.path);
              const res = await API.get<{ content: string }>(
                `/workspaces/${id}/files?path=${encodeURIComponent(r.path)}`,
              );
              setContent(res.content);
              setDirty(false);
              setSavingState("idle");
            } catch (e: any) {
              alert(e?.message ?? "Failed to open config");
            }
          }}
        >
          <Settings size={14} />
        </button>
        {w?.status === "running" ? (
          <>
            <button
              className="btn-secondary"
              title="Restart"
              onClick={() => startStop.mutate("restart")}
            >
              <RotateCw size={14} />
            </button>
            <button className="btn-secondary" onClick={() => startStop.mutate("stop")}>
              <Square size={14} /> Stop
            </button>
          </>
        ) : (
          <button className="btn-primary" onClick={() => startStop.mutate("start")}>
            <Play size={14} /> Run
          </button>
        )}
        <button
          className="btn-secondary"
          title="Git: status, commit, push, pull"
          onClick={() => setShowGit(true)}
        >
          <GitBranch size={14} />
        </button>
        <div className="relative">
          <button
            className="btn-secondary"
            title="Quick AI actions on the active file"
            onClick={() => { setShowQuickActions((v) => !v); }}
          >
            <Wand2 size={14} />
          </button>
          {showQuickActions && (
            <QuickActionsMenu
              activePath={activePath}
              onClose={() => setShowQuickActions(false)}
              onPick={(prompt) => {
                setShowQuickActions(false);
                setShowAI(true);
                window.dispatchEvent(new CustomEvent("premdev:ai:prefill", {
                  detail: { text: prompt, send: true },
                }));
              }}
            />
          )}
        </div>
        <button className="btn-secondary" onClick={() => setShowAI((s) => !s)}>
          <Sparkles size={14} /> AI
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          <Panel defaultSize={18} minSize={12} maxSize={30}>
            <FileTree
              workspaceId={id!}
              confirm={confirm}
              onSelect={async (p) => {
                if (dirty && activePath) {
                  // Auto-save before switching to avoid losing edits silently
                  if (saveTimer.current) {
                    clearTimeout(saveTimer.current);
                    saveTimer.current = null;
                  }
                  await saveNow(activePath, content);
                }
                setActivePath(p);
                const res = await API.get<{ content: string }>(
                  `/workspaces/${id}/files?path=${encodeURIComponent(p)}`
                );
                setContent(res.content);
                setDirty(false);
                setSavingState("idle");
              }}
              activePath={activePath}
            />
          </Panel>
          <PanelResizeHandle className="w-px bg-bg-border hover:bg-accent" />

          <Panel defaultSize={showAI ? 50 : 60}>
            <PanelGroup direction="vertical">
              <Panel defaultSize={65} minSize={20}>
                {activePath ? (
                  <Editor
                    height="100%"
                    theme="vs-dark"
                    path={activePath}
                    value={content}
                    onMount={(ed, monaco) => {
                      editorRef.current = ed;
                      // Selection-based ask (Batch A #4): right-click /
                      // Cmd+I to send the highlighted code into the AI
                      // chat with an "Explain / Refactor / Fix" preface.
                      const send = (preface: string) => {
                        const sel = ed.getSelection();
                        const model = ed.getModel();
                        if (!sel || !model) return;
                        const text = model.getValueInRange(sel) || "";
                        const path = activePathRef.current ?? "(unsaved)";
                        const prefilled =
                          `${preface}\n\nFile: \`${path}\` (lines ${sel.startLineNumber}-${sel.endLineNumber})\n\n` +
                          "```\n" + (text || "(empty selection — entire file context implied)") + "\n```";
                        setShowAI(true);
                        window.dispatchEvent(new CustomEvent("premdev:ai:prefill", {
                          detail: { text: prefilled },
                        }));
                      };
                      ed.addAction({
                        id: "premdev.askAI",
                        label: "PremDev: Ask AI about selection",
                        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
                        contextMenuGroupId: "premdev",
                        contextMenuOrder: 1,
                        run: () => send("Explain what this code does and call out anything risky."),
                      });
                      ed.addAction({
                        id: "premdev.refactorAI",
                        label: "PremDev: Refactor selection with AI",
                        contextMenuGroupId: "premdev",
                        contextMenuOrder: 2,
                        run: () => send("Refactor the selected code for clarity and reuse. Then patch the file in place."),
                      });
                      ed.addAction({
                        id: "premdev.fixAI",
                        label: "PremDev: Fix selection with AI",
                        contextMenuGroupId: "premdev",
                        contextMenuOrder: 3,
                        run: () => send("Find the bug in this selection and fix it. After patching, run diag:run."),
                      });
                    }}
                    onChange={(v) => {
                      setContent(v ?? "");
                      setDirty(true);
                      lastEditGenRef.current++;
                      setSavingState("idle");
                    }}
                    options={{
                      fontSize: 13,
                      fontFamily:
                        "JetBrains Mono, Fira Code, Menlo, monospace",
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      tabSize: 2,
                    }}
                  />
                ) : (
                  <div className="grid h-full place-items-center text-text-muted">
                    Select a file to edit
                  </div>
                )}
              </Panel>
              <PanelResizeHandle className="h-px bg-bg-border hover:bg-accent" />
              <Panel defaultSize={35} minSize={10}>
                <BottomTabs workspaceId={id!} workspace={w} />
              </Panel>
            </PanelGroup>
          </Panel>

          {showAI && (
            <>
              <PanelResizeHandle className="w-px bg-bg-border hover:bg-accent" />
              <Panel defaultSize={30} minSize={20}>
                <AIChat
                  workspaceId={id!}
                  onWorkspaceMutated={() => qc.invalidateQueries({ queryKey: ["workspace", id] })}
                  onFilesMutated={() => qc.invalidateQueries({ queryKey: ["files", id] })}
                />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>

      {showCheckpoints && (
        <CheckpointsModal
          workspaceId={id!}
          onClose={() => setShowCheckpoints(false)}
          confirm={confirm}
        />
      )}
      {showSecrets && (
        <SecretsPanel
          workspaceId={id!}
          onClose={() => setShowSecrets(false)}
        />
      )}
      {showSubdomain && w && (
        <SubdomainPanel
          workspaceId={id!}
          workspace={w}
          onClose={() => setShowSubdomain(false)}
          onSaved={() => qc.invalidateQueries({ queryKey: ["workspace", id] })}
        />
      )}
      {showGit && (
        <GitPanel
          workspaceId={id!}
          onClose={() => setShowGit(false)}
        />
      )}
      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------
// QuickActionsMenu — small dropdown of canned prompts that operate on the
// currently-open file. Each pick is sent straight to AI panel via the
// premdev:ai:prefill event (with send=true so the request fires
// immediately instead of waiting for the user to press Enter).
// ---------------------------------------------------------------------
function QuickActionsMenu({
  activePath,
  onPick,
  onClose,
}: {
  activePath: string | null;
  onPick: (prompt: string) => void;
  onClose: () => void;
}) {
  // Click-outside dismissal — registered on first render so any click that
  // isn't on the menu closes it. The button that opens the menu also calls
  // setShowQuickActions((v) => !v), so a second click on it still toggles.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(ev: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(ev.target as Node)) onClose();
    }
    // Defer one tick so the very click that opened us doesn't immediately close us.
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onDoc); };
  }, [onClose]);
  const file = activePath ?? "(no file open)";
  const items: Array<{ label: string; prompt: string }> = [
    {
      label: "Explain this file",
      prompt: `Explain what \`${file}\` does, its public API, and how it interacts with the rest of the project. Don't change anything.`,
    },
    {
      label: "Find bugs / risks",
      prompt: `Audit \`${file}\` for bugs, race conditions, missing error handling, and security risks. Output a numbered list with severity. Don't patch yet.`,
    },
    {
      label: "Refactor for readability",
      prompt: `Refactor \`${file}\` for readability and maintainability without changing behavior. Use patch: blocks, then run diag:run.`,
    },
    {
      label: "Add doc comments",
      prompt: `Add concise doc comments (JSDoc / docstring / equivalent) to every exported symbol in \`${file}\`. Don't change behavior.`,
    },
    {
      label: "Add types",
      prompt: `Strengthen the type annotations in \`${file}\` (TypeScript / Python type hints / etc.) where currently missing. Use patch: blocks, then run diag:run.`,
    },
    {
      label: "Generate tests",
      prompt: `Generate a focused test file covering the public surface of \`${file}\`. After writing it, run test:run.`,
    },
    {
      label: "Optimize performance",
      prompt: `Identify the hottest path in \`${file}\` and propose 1-2 concrete optimisations with measurable trade-offs. Don't patch unless I confirm.`,
    },
  ];
  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 w-64 rounded-md border border-bg-border bg-bg-subtle p-1 text-xs shadow-lg z-20"
    >
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-text-muted">
        Quick actions {activePath ? `· ${activePath.split("/").pop()}` : ""}
      </div>
      {items.map((it) => (
        <button
          key={it.label}
          className="block w-full truncate rounded px-2 py-1.5 text-left hover:bg-bg-base disabled:opacity-50"
          disabled={!activePath}
          onClick={() => onPick(it.prompt)}
          title={!activePath ? "Open a file first" : it.prompt}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// GitPanel — read-only-by-default modal that surfaces git status, recent
// commits, and a small write surface (commit / push / pull). All ops run
// inside the workspace container via /workspaces/:id/git/* so they use
// the user's own git credentials and config.
// ---------------------------------------------------------------------
function GitPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: status, isLoading: statusLoading, error: statusErr, refetch: refetchStatus } = useQuery({
    queryKey: ["git", workspaceId, "status"],
    queryFn: () => API.get<any>(`/workspaces/${workspaceId}/git/status`),
    refetchOnWindowFocus: false,
  });
  const { data: log } = useQuery({
    queryKey: ["git", workspaceId, "log"],
    queryFn: () => API.get<any>(`/workspaces/${workspaceId}/git/log`),
    enabled: !!status?.initialised,
    refetchOnWindowFocus: false,
  });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<string>("");

  async function run(label: string, fn: () => Promise<any>) {
    setBusy(true);
    setOutput(`→ ${label}…`);
    try {
      const r = await fn();
      setOutput(`${label}\n${r?.output ?? JSON.stringify(r, null, 2)}`);
      await refetchStatus();
      await qc.invalidateQueries({ queryKey: ["git", workspaceId, "log"] });
    } catch (e: any) {
      setOutput(`${label} failed: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const dirty = (status?.files?.length ?? 0) > 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-2xl overflow-auto rounded-lg border border-bg-border bg-bg-base p-5 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <GitBranch size={18} /> Git
          </h2>
          <button className="btn-ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {statusLoading && <div className="text-text-muted">Loading…</div>}
        {statusErr && (
          <div className="rounded-md bg-danger/10 p-3 text-xs text-danger">
            {String((statusErr as any)?.message ?? statusErr)}
          </div>
        )}
        {status && !status.initialised && (
          <div className="space-y-3">
            <p className="text-sm text-text-muted">
              No git repository in this workspace yet.
            </p>
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() => run("git init", () => API.post(`/workspaces/${workspaceId}/exec`, { command: "git init && git add -A && git commit --allow-empty -m 'Initial commit' || true" }))}
            >
              Initialise repo
            </button>
          </div>
        )}
        {status?.initialised && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-3 rounded-md bg-bg-subtle p-3 text-xs">
              <span><span className="text-text-muted">Branch:</span> <code>{status.branch || "(detached)"}</code></span>
              <span><span className="text-text-muted">Ahead:</span> {status.ahead}</span>
              <span><span className="text-text-muted">Behind:</span> {status.behind}</span>
              {status.remote && <span className="text-text-muted truncate max-w-xs" title={status.remote}>{status.remote.split("\n")[0]}</span>}
            </div>

            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-text-muted">Changes ({status.files.length})</div>
              {status.files.length === 0 ? (
                <div className="rounded-md bg-bg-subtle p-3 text-xs text-text-muted">Working tree clean.</div>
              ) : (
                <div className="max-h-40 overflow-auto rounded-md border border-bg-border">
                  {status.files.map((f: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1 text-xs odd:bg-bg-subtle">
                      <code className="w-8 text-text-muted">{f.x}{f.y}</code>
                      <span className="truncate">{f.path}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <input
                className="input w-full text-xs"
                placeholder="Commit message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn-primary"
                  disabled={busy || !message.trim() || !dirty}
                  onClick={() => run("commit", () =>
                    API.post(`/workspaces/${workspaceId}/git/commit`, { message: message.trim(), addAll: true }),
                  )}
                >
                  Commit (add all)
                </button>
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => run("push", () => API.post(`/workspaces/${workspaceId}/git/push`, {}))}
                >
                  Push
                </button>
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => run("pull --ff-only", () => API.post(`/workspaces/${workspaceId}/git/pull`, {}))}
                >
                  Pull
                </button>
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await API.get<{ diff: string }>(`/workspaces/${workspaceId}/git/diff`);
                      setOutput("git diff\n" + (r.diff || "(no unstaged changes)"));
                    } finally { setBusy(false); }
                  }}
                >
                  Diff
                </button>
              </div>
            </div>

            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-text-muted">Recent commits</div>
              <div className="max-h-40 overflow-auto rounded-md border border-bg-border">
                {(log?.commits ?? []).length === 0 && (
                  <div className="px-3 py-2 text-xs text-text-muted">No commits yet.</div>
                )}
                {(log?.commits ?? []).map((c: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1 text-xs odd:bg-bg-subtle">
                    <code className="text-accent">{c.hash}</code>
                    <span className="truncate">{c.subject}</span>
                    <span className="ml-auto text-text-muted">{c.when}</span>
                  </div>
                ))}
              </div>
            </div>

            {output && (
              <pre className="max-h-40 overflow-auto rounded-md bg-bg-subtle p-2 text-[11px]">{output}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// SubdomainPanel — modal for editing the workspace's custom subdomain.
// Debounces the availability check so we don't hammer the backend on
// every keystroke; shows live validation state (idle/checking/ok/error)
// and lets the user clear the custom mapping to fall back to the default
// <project>-<user>.<domain> form. Pure UI — server is the source of
// truth; on save we re-fetch the workspace via the parent's invalidate.
// ---------------------------------------------------------------------
function SubdomainPanel({
  workspaceId,
  workspace,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  workspace: Workspace;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<string>(workspace.customSubdomain ?? "");
  const [check, setCheck] = useState<
    | { state: "idle" }
    | { state: "checking" }
    | { state: "ok" }
    | { state: "error"; message: string }
  >({ state: "idle" });
  const [saving, setSaving] = useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  // Track the latest in-flight check so a stale 200 can't overwrite a
  // newer 409 (or vice versa) when the user types fast.
  const checkSeqRef = useRef(0);

  const trimmed = value.trim().toLowerCase();
  const unchanged = trimmed === (workspace.customSubdomain ?? "");

  useEffect(() => {
    if (unchanged || trimmed === "") {
      setCheck({ state: "idle" });
      return;
    }
    const mySeq = ++checkSeqRef.current;
    setCheck({ state: "checking" });
    const t = setTimeout(async () => {
      try {
        const r = await API.get<{ available: boolean; error?: string }>(
          `/workspaces/check-subdomain?value=${encodeURIComponent(trimmed)}&ignoreId=${encodeURIComponent(workspaceId)}`,
        );
        if (mySeq !== checkSeqRef.current) return;
        if (r.available) setCheck({ state: "ok" });
        else setCheck({ state: "error", message: r.error ?? "Not available" });
      } catch (e: any) {
        if (mySeq !== checkSeqRef.current) return;
        setCheck({ state: "error", message: e?.message ?? "Check failed" });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [trimmed, unchanged, workspaceId]);

  async function save(next: string | null) {
    setSaving("saving");
    setSaveError(null);
    try {
      await API.put(`/workspaces/${workspaceId}/subdomain`, {
        subdomain: next,
      });
      onSaved();
      onClose();
    } catch (e: any) {
      setSaving("error");
      setSaveError(e?.message ?? "Save failed");
    }
  }

  const canSave =
    !unchanged &&
    saving !== "saving" &&
    (trimmed === "" || check.state === "ok");

  // Show a live preview of the URL the workspace will be reachable at.
  // Pull the host from defaultUrl (e.g. "https://foo-bar.flixprem.org") and
  // swap the subdomain — that way we don't have to know PRIMARY_DOMAIN here.
  const previewUrl = (() => {
    if (!workspace.defaultUrl) return null;
    try {
      const u = new URL(workspace.defaultUrl);
      const host = u.hostname;
      const tld = host.split(".").slice(1).join(".");
      const sub = trimmed || workspace.defaultUrl.split("//")[1].split(".")[0];
      return `${u.protocol}//${sub}.${tld}`;
    } catch {
      return null;
    }
  })();

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-bg-border bg-bg-panel p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Globe size={18} /> Custom subdomain
          </h2>
          <button className="btn-ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="mb-3 text-xs text-text-muted">
          Pick any unused subdomain (lowercase letters, digits, and hyphens).
          When set, your workspace will be reachable at this address instead of
          the default <code className="text-text">{workspace.defaultUrl}</code>.
        </p>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">
              Subdomain
            </label>
            <div className="flex items-center gap-2">
              <input
                autoFocus
                className="input flex-1"
                placeholder="myapp"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              {check.state === "checking" && (
                <Loader2 size={16} className="animate-spin text-text-muted" />
              )}
              {check.state === "ok" && <CheckIcon size={16} className="text-success" />}
              {check.state === "error" && <AlertTriangle size={16} className="text-danger" />}
            </div>
            {check.state === "error" && (
              <div className="mt-1 text-xs text-danger">{check.message}</div>
            )}
            {check.state === "ok" && (
              <div className="mt-1 text-xs text-success">Available</div>
            )}
          </div>
          {previewUrl && (
            <div className="rounded border border-bg-border bg-bg p-3 text-xs">
              <div className="text-text-muted">Will be reachable at:</div>
              <div className="mt-1 break-all font-mono text-accent">{previewUrl}</div>
            </div>
          )}
          {saveError && (
            <div className="rounded border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
              {saveError}
            </div>
          )}
        </div>
        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            className="btn-ghost text-xs"
            onClick={() => save(null)}
            disabled={saving === "saving" || workspace.customSubdomain == null}
            title="Revert to the default <project>-<user> URL"
          >
            <Trash2 size={12} /> Clear (use default)
          </button>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => save(trimmed === "" ? null : trimmed)}
              disabled={!canSave}
            >
              {saving === "saving" ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FileTree({
  workspaceId,
  onSelect,
  activePath,
  confirm,
}: {
  workspaceId: string;
  onSelect: (p: string) => void;
  activePath: string | null;
  confirm: (o: any) => Promise<boolean>;
}) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Show hidden files (dotfiles like .env). Persisted per-browser so users
  // don't have to re-enable on every page load.
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem("premdev.showHidden") === "1";
    } catch {
      return false;
    }
  });
  function toggleShowHidden() {
    setShowHidden((v) => {
      const next = !v;
      try {
        localStorage.setItem("premdev.showHidden", next ? "1" : "0");
      } catch {}
      return next;
    });
  }
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["files", workspaceId, showHidden],
    queryFn: () =>
      API.get<{ tree: FileNode[] }>(
        `/workspaces/${workspaceId}/tree${showHidden ? "?showHidden=1" : ""}`,
      ),
  });

  const create = useMutation({
    mutationFn: (body: { path: string; type: "file" | "dir" }) =>
      API.post(`/workspaces/${workspaceId}/files/create`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files", workspaceId] }),
  });
  const del = useMutation({
    mutationFn: (paths: string | string[]) =>
      API.post(
        `/workspaces/${workspaceId}/files/delete`,
        Array.isArray(paths) ? { paths } : { path: paths },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files", workspaceId] }),
  });
  const rename = useMutation({
    mutationFn: (body: { from: string; to: string }) =>
      API.post(`/workspaces/${workspaceId}/files/rename`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files", workspaceId] }),
  });

  async function handleDelete(p: string) {
    // If `p` is part of an active multi-selection (size > 1), bulk-delete
    // ALL selected paths in one request — the user almost certainly meant
    // "delete the things I just selected" rather than "delete only this
    // one item that happened to be the click target".
    const inSelection = selectedPaths.has(p) && selectedPaths.size > 1;
    if (inSelection) {
      const list = Array.from(selectedPaths);
      const preview = list.slice(0, 8).map((x) => `• ${x}`).join("\n");
      const more = list.length > 8 ? `\n…dan ${list.length - 8} item lainnya` : "";
      const ok = await confirm({
        title: `Hapus ${list.length} item?`,
        message: `Akan menghapus:\n${preview}${more}\n\nAksi ini tidak bisa dibatalkan.`,
        confirmLabel: `Hapus ${list.length} item`,
        danger: true,
      });
      if (!ok) return;
      try {
        await del.mutateAsync(list);
      } catch (e: any) {
        alert(e.message ?? "Bulk delete failed");
      }
      setSelectedPaths(new Set());
      return;
    }
    const ok = await confirm({
      title: "Hapus file?",
      message: `Yakin mau hapus "${p}"?\nAksi ini tidak bisa dibatalkan.`,
      confirmLabel: "Hapus",
      danger: true,
    });
    if (ok) del.mutate(p);
  }

  async function handleRename(p: string) {
    const next = window.prompt("New name (you can include subfolders):", p);
    if (!next || next === p) return;
    try {
      await rename.mutateAsync({ from: p, to: next });
    } catch (e: any) {
      alert(e.message ?? "Rename failed");
    }
  }

  // Multi-select state for the tree.
  //   - Ctrl/Cmd+click toggles a single entry.
  //   - Shift+click selects an inclusive range from the last anchor.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);

  // Expanded folders, lifted from <NodeRow> so we know which paths are
  // actually visible (matters for Shift+click range select). All folders
  // start collapsed by default — user explicitly opens what they need.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggleExpand(p: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function toggleSelect(p: string, additive: boolean) {
    setSelectedPaths((prev) => {
      const next = new Set(additive ? prev : []);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
    anchorRef.current = p;
  }
  function clearSelection() {
    setSelectedPaths((prev) => (prev.size ? new Set() : prev));
  }

  // DFS-flatten the tree but skip children of folders the user collapsed,
  // so range selection only ever picks rows the user can actually see.
  function visiblePaths(nodes: FileNode[] | undefined): string[] {
    const out: string[] = [];
    function walk(list: FileNode[]) {
      for (const n of list) {
        out.push(n.path);
        if (n.type === "dir" && n.children?.length && expanded.has(n.path)) {
          walk(n.children);
        }
      }
    }
    if (nodes) walk(nodes);
    return out;
  }
  function rangeSelect(target: string) {
    const flat = visiblePaths(data?.tree);
    const anchor = anchorRef.current;
    if (!anchor || !flat.includes(anchor)) {
      setSelectedPaths(new Set([target]));
      anchorRef.current = target;
      return;
    }
    const a = flat.indexOf(anchor);
    const b = flat.indexOf(target);
    if (b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelectedPaths(new Set(flat.slice(lo, hi + 1)));
    // Keep the original anchor so the user can extend the range further.
  }

  // Move via drag-and-drop. destDir "" means workspace root. `from` may be
  // a single path or many paths (when the user drags a multi-selection).
  async function handleMove(from: string | string[], destDir: string) {
    const fromList = Array.isArray(from) ? from : [from];
    const failures: string[] = [];
    for (const src of fromList) {
      const base = src.split("/").pop()!;
      const to = destDir ? `${destDir}/${base}` : base;
      if (to === src) continue;
      // Reject moving a folder into itself or any descendant.
      if (destDir === src || destDir.startsWith(`${src}/`)) {
        failures.push(`${src}: can't move into itself`);
        continue;
      }
      try {
        await rename.mutateAsync({ from: src, to });
      } catch (e: any) {
        failures.push(`${src}: ${e?.message ?? "move failed"}`);
      }
    }
    clearSelection();
    if (failures.length) alert(`Move issues:\n${failures.join("\n")}`);
  }

  function downloadZip() {
    const link = document.createElement("a");
    link.href = `/api/workspaces/${workspaceId}/download-zip`;
    link.click();
  }

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      try {
        // Zip files: send to extract endpoint so binary contents survive.
        if (/\.zip$/i.test(file.name)) {
          const fd = new FormData();
          fd.append("file", file);
          const res = await fetch(`/api/workspaces/${workspaceId}/upload-zip`, {
            method: "POST",
            credentials: "include",
            body: fd,
          });
          if (!res.ok) {
            let msg = res.statusText;
            try {
              const body = await res.json();
              msg = body?.error ?? JSON.stringify(body);
            } catch {
              try { msg = await res.text(); } catch {}
            }
            throw new Error(msg);
          }
        } else {
          const reader = new FileReader();
          const text = await new Promise<string>((res, rej) => {
            reader.onload = () => res(String(reader.result || ""));
            reader.onerror = rej;
            reader.readAsText(file);
          });
          await API.post(`/workspaces/${workspaceId}/files/create`, {
            path: file.name,
            type: "file",
          });
          await API.put(`/workspaces/${workspaceId}/files`, {
            path: file.name,
            content: text,
          });
        }
      } catch (e: any) {
        failures.push(`${file.name}: ${e?.message ?? String(e)}`);
      }
    }
    qc.invalidateQueries({ queryKey: ["files", workspaceId] });
    if (failures.length) alert(`Some uploads failed:\n${failures.join("\n")}`);
  }

  return (
    <div className="flex h-full flex-col bg-bg-panel">
      <div
        className="flex items-center justify-between border-b border-bg-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted"
        title="Click to open • Ctrl/Cmd-click to add to selection • Shift-click to select a range • Drag onto a folder to move"
      >
        Files
        <div className="flex gap-1">
          <button
            className="btn-ghost p-1"
            title="New file"
            onClick={() => {
              const p = window.prompt("File path (e.g. src/main.ts):");
              if (p) create.mutate({ path: p, type: "file" });
            }}
          >
            <Plus size={12} />
          </button>
          <button
            className="btn-ghost p-1"
            title="Upload files"
            onClick={() => fileInputRef.current?.click()}
          >
            <span className="text-[10px]">⇪</span>
          </button>
          <button
            className="btn-ghost p-1"
            title="Download as zip"
            onClick={downloadZip}
          >
            <Download size={12} />
          </button>
          <button
            className={`btn-ghost p-1 ${showHidden ? "text-accent" : ""}`}
            title={showHidden ? "Hide hidden files (.env, .gitignore, ...)" : "Show hidden files (.env, .gitignore, ...)"}
            onClick={toggleShowHidden}
          >
            {showHidden ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
          <button
            className="btn-ghost p-1"
            title="Refresh"
            onClick={() => refetch()}
          >
            <RefreshCw size={12} />
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => uploadFiles(e.target.files)}
        />
      </div>
      <div
        className="flex-1 overflow-auto py-1 text-sm"
        // Drop on empty area / root container → move to workspace root.
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DND_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData(DND_MIME);
          if (!raw) return;
          e.preventDefault();
          handleMove(raw.split("\n").filter(Boolean), "");
        }}
        // Click on empty space clears the multi-selection.
        onClick={(e) => {
          if (e.target === e.currentTarget) clearSelection();
        }}
      >
        {isLoading ? (
          <div className="px-3 py-2 text-text-muted">Loading…</div>
        ) : (
          <Tree
            nodes={data?.tree ?? []}
            depth={0}
            onSelect={onSelect}
            activePath={activePath}
            onDelete={handleDelete}
            onRename={handleRename}
            onMove={handleMove}
            selected={selectedPaths}
            onToggleSelect={toggleSelect}
            onClearSelection={clearSelection}
            onRangeSelect={rangeSelect}
            expanded={expanded}
            onToggleExpand={toggleExpand}
          />
        )}
      </div>
    </div>
  );
}

const DND_MIME = "application/x-premdev-path";

function Tree({
  nodes, depth, onSelect, activePath, onDelete, onRename, onMove,
  selected, onToggleSelect, onClearSelection, onRangeSelect,
  expanded, onToggleExpand,
}: any) {
  return (
    <ul>
      {nodes.map((n: FileNode) => (
        <NodeRow
          key={n.path}
          node={n}
          depth={depth}
          onSelect={onSelect}
          activePath={activePath}
          onDelete={onDelete}
          onRename={onRename}
          onMove={onMove}
          selected={selected}
          onToggleSelect={onToggleSelect}
          onClearSelection={onClearSelection}
          onRangeSelect={onRangeSelect}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
        />
      ))}
    </ul>
  );
}

function NodeRow({
  node, depth, onSelect, activePath, onDelete, onRename, onMove,
  selected, onToggleSelect, onClearSelection, onRangeSelect,
  expanded, onToggleExpand,
}: any) {
  const open: boolean = expanded?.has(node.path) ?? false;
  const [dragOver, setDragOver] = useState(false);
  const isActive = activePath === node.path;
  const isSelected: boolean = selected?.has(node.path) ?? false;

  function startDrag(e: React.DragEvent) {
    e.stopPropagation();
    // If the dragged item is part of the multi-selection, transfer ALL
    // selected paths (newline-separated). Otherwise transfer just this one
    // and clear any prior selection so behaviour stays predictable.
    let payload: string;
    if (isSelected && selected && selected.size > 1) {
      payload = Array.from(selected as Set<string>).join("\n");
    } else {
      payload = node.path;
      onClearSelection?.();
    }
    e.dataTransfer.setData(DND_MIME, payload);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleRowClick(e: React.MouseEvent, primary: () => void) {
    // Shift takes priority over Ctrl/Cmd so that Shift+Cmd still extends the
    // range (matching Finder/Explorer/VSCode behaviour).
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      // Block the browser's native text selection that Shift-click would draw.
      window.getSelection?.()?.removeAllRanges();
      onRangeSelect?.(node.path);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect?.(node.path, true);
      return;
    }
    onClearSelection?.();
    primary();
  }

  if (node.type === "dir") {
    return (
      <li>
        <div
          draggable
          onDragStart={startDrag}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DND_MIME)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            const raw = e.dataTransfer.getData(DND_MIME);
            setDragOver(false);
            if (!raw) return;
            e.preventDefault();
            e.stopPropagation();
            onMove(raw.split("\n").filter(Boolean), node.path);
          }}
          className={`group flex cursor-pointer items-center gap-1 px-2 py-0.5 hover:bg-bg-hover ${
            isActive ? "bg-bg-hover" : ""
          } ${isSelected ? "bg-accent/15" : ""} ${
            dragOver ? "ring-1 ring-accent bg-accent/10" : ""
          }`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={(e) => handleRowClick(e, () => onToggleExpand?.(node.path))}
        >
          {open ? (
            <ChevronDown size={12} className="text-text-muted" />
          ) : (
            <ChevronRight size={12} className="text-text-muted" />
          )}
          <Folder size={12} className="text-accent" />
          <span className="truncate">{node.name}</span>
          <div className="ml-auto hidden gap-0.5 group-hover:flex">
            <button
              className="p-0.5 text-text-muted hover:text-text"
              title="Rename"
              onClick={(e) => { e.stopPropagation(); onRename(node.path); }}
            >
              <Pencil size={10} />
            </button>
            <button
              className="p-0.5 text-text-muted hover:text-danger"
              title="Delete"
              onClick={(e) => { e.stopPropagation(); onDelete(node.path); }}
            >
              <Trash2 size={10} />
            </button>
          </div>
        </div>
        {open && node.children && (
          <Tree
            nodes={node.children}
            depth={depth + 1}
            onSelect={onSelect}
            activePath={activePath}
            onDelete={onDelete}
            onRename={onRename}
            onMove={onMove}
            selected={selected}
            onToggleSelect={onToggleSelect}
            onClearSelection={onClearSelection}
            onRangeSelect={onRangeSelect}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
          />
        )}
      </li>
    );
  }
  return (
    <li>
      <div
        draggable
        onDragStart={startDrag}
        className={`group flex cursor-pointer items-center gap-1 px-2 py-0.5 hover:bg-bg-hover ${
          isActive ? "bg-accent/20 text-accent" : ""
        } ${isSelected ? "bg-accent/15" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 + 12 }}
        onClick={(e) => handleRowClick(e, () => onSelect(node.path))}
      >
        <FileIcon size={12} className="text-text-muted" />
        <span className="truncate">{node.name}</span>
        <div className="ml-auto hidden gap-0.5 group-hover:flex">
          <button
            className="p-0.5 text-text-muted hover:text-text"
            title="Rename"
            onClick={(e) => { e.stopPropagation(); onRename(node.path); }}
          >
            <Pencil size={10} />
          </button>
          <button
            className="p-0.5 text-text-muted hover:text-danger"
            title="Delete"
            onClick={(e) => { e.stopPropagation(); onDelete(node.path); }}
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>
    </li>
  );
}

function BottomTabs({ workspaceId, workspace }: { workspaceId: string; workspace?: Workspace }) {
  const [tab, setTab] = useState<"console" | "terminal" | "preview">("console");
  const status = workspace?.status ?? "stopped";
  return (
    <div className="flex h-full flex-col bg-bg-panel">
      <div className="flex border-b border-bg-border">
        {(["console", "terminal", "preview"] as const).map((t) => (
          <button
            key={t}
            className={`px-4 py-2 text-xs font-medium uppercase tracking-wide transition ${
              tab === t
                ? "bg-bg text-text border-t-2 border-accent"
                : "text-text-muted hover:text-text"
            }`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
        {workspace?.previewUrl && (
          <a
            className="ml-auto flex items-center gap-1 px-3 text-xs text-text-muted hover:text-text"
            href={workspace.previewUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={12} /> Open
          </a>
        )}
      </div>
      {/*
        Keep all panes mounted at all times so the terminal session and
        preview iframe survive tab switches. We use `hidden` instead of
        conditional render — switching tabs no longer drops the WS or
        wipes scrollback.
      */}
      <div className="relative flex-1 overflow-hidden">
        <div className={`absolute inset-0 ${tab === "console" ? "" : "hidden"}`}>
          <ConsolePane workspaceId={workspaceId} status={status} />
        </div>
        <div className={`absolute inset-0 ${tab === "terminal" ? "" : "hidden"}`}>
          <TerminalPane workspaceId={workspaceId} />
        </div>
        <div className={`absolute inset-0 ${tab === "preview" ? "" : "hidden"}`}>
          {workspace?.previewUrl ? (
            <iframe
              key={workspace.previewUrl}
              src={workspace.previewUrl}
              className="h-full w-full bg-white"
              title="preview"
            />
          ) : (
            <div className="grid h-full place-items-center text-text-muted">
              Start the workspace to see preview
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Console tab — shows the live stdout/stderr of the workflow process started
// by Run/Restart (analogous to Replit's Console). Auto-scrolls when new
// output appears, includes a Clear button (cosmetic — doesn't touch the
// backend buffer) and a colored status pill so users can tell at a glance
// whether their program is running, stopped, or crashed.
function ConsolePane({
  workspaceId,
  status,
}: {
  workspaceId: string;
  status: "stopped" | "starting" | "running" | "error";
}) {
  const [logs, setLogs] = useState("");
  // Snapshot of `logs` at the moment the user clicked Clear. As long as the
  // server keeps returning a string that starts with this snapshot, the UI
  // shows only the suffix. If the buffer rotates or the workspace restarts
  // (snapshot no longer prefixes the new logs), we drop the snapshot so the
  // user isn't stuck with an empty Console.
  const [clearedSnapshot, setClearedSnapshot] = useState<string>("");
  const ref = useRef<HTMLPreElement>(null);
  // Faster polling while running so the console feels live; slower when
  // stopped to save bandwidth.
  const refetchInterval = status === "running" || status === "starting" ? 1500 : 5000;
  const { data } = useQuery({
    queryKey: ["logs", workspaceId],
    queryFn: () => API.get<{ logs: string }>(`/workspaces/${workspaceId}/logs`),
    refetchInterval,
  });
  useEffect(() => {
    if (data?.logs === undefined || data.logs === logs) return;
    // Capture "was near the bottom?" BEFORE the DOM swaps in the new text —
    // afterwards the scrollHeight has already grown so the heuristic lies.
    const el = ref.current;
    const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setLogs(data.logs);
    if (nearBottom) {
      requestAnimationFrame(() => {
        const e2 = ref.current;
        if (e2) e2.scrollTop = e2.scrollHeight;
      });
    }
  }, [data, logs]);

  // Drop the cleared snapshot if the live logs no longer start with it
  // (workspace restarted, rotation kicked in, etc) — otherwise the user gets
  // a permanently empty Console.
  const visible =
    clearedSnapshot && logs.startsWith(clearedSnapshot)
      ? logs.slice(clearedSnapshot.length)
      : logs;
  const statusMeta: Record<typeof status, { label: string; cls: string }> = {
    running: { label: "● Running", cls: "text-success" },
    starting: { label: "● Starting", cls: "text-warning" },
    error: { label: "● Error", cls: "text-danger" },
    stopped: { label: "○ Stopped", cls: "text-text-muted" },
  };
  const sm = statusMeta[status];

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex items-center gap-2 border-b border-bg-border px-3 py-1 text-[11px]">
        <span className={`font-semibold ${sm.cls}`}>{sm.label}</span>
        <span className="text-text-muted">workflow output</span>
        <button
          className="ml-auto text-text-muted hover:text-text"
          onClick={() => setClearedSnapshot(logs)}
          title="Clear screen (output buffer on the server stays intact)"
        >
          Clear
        </button>
      </div>
      <pre
        ref={ref}
        className="flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed text-text"
      >
        {visible ||
          "(Console is empty. Click Run to start your project — its output will appear here.)"}
      </pre>
    </div>
  );
}

function CheckpointsModal({
  workspaceId,
  onClose,
  confirm,
}: {
  workspaceId: string;
  onClose: () => void;
  confirm: (o: any) => Promise<boolean>;
}) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState("");
  // When set, opens a child modal listing files inside the chosen checkpoint
  // (the "Changes" button). Stays mounted on top of CheckpointsModal so the
  // user can flip back to the timeline without losing scroll position.
  const [filesFor, setFilesFor] = useState<Checkpoint | null>(null);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["checkpoints", workspaceId],
    queryFn: () => API.get<{ checkpoints: Checkpoint[] }>(`/workspaces/${workspaceId}/checkpoints`),
  });
  const create = useMutation({
    mutationFn: () => API.post(`/workspaces/${workspaceId}/checkpoints`, { message: msg || "Manual checkpoint" }),
    onSuccess: () => { setMsg(""); refetch(); },
  });
  const restore = useMutation({
    mutationFn: (cid: string) => API.post(`/workspaces/${workspaceId}/checkpoints/${cid}/restore`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files", workspaceId] }),
  });
  const del = useMutation({
    mutationFn: (cid: string) => API.delete(`/workspaces/${workspaceId}/checkpoints/${cid}`),
    onSuccess: () => refetch(),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Checkpoints</h2>
          <button className="btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="mb-4 flex gap-2">
          <input
            className="input flex-1"
            placeholder="Checkpoint message (optional)"
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
          />
          <button
            className="btn-primary"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            Save checkpoint
          </button>
        </div>
        <div className="max-h-[50vh] overflow-auto">
          {isLoading ? (
            <div className="text-text-muted">Loading…</div>
          ) : data?.checkpoints?.length ? (
            <ul className="divide-y divide-bg-border">
              {data.checkpoints.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2">
                  <div className="flex-1">
                    <div className="text-sm">{c.message}</div>
                    <div className="text-[11px] text-text-muted">
                      {new Date(c.created_at).toLocaleString()} · {(c.size_bytes / 1024).toFixed(1)} KB
                    </div>
                  </div>
                  <button
                    className="btn-ghost text-xs"
                    title="Lihat daftar file di checkpoint ini"
                    onClick={() => setFilesFor(c)}
                  >
                    Changes
                  </button>
                  <button
                    className="btn-secondary text-xs"
                    title="Kembalikan workspace ke kondisi waktu checkpoint ini"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Rollback ke checkpoint ini?",
                        message: "File workspace akan ditimpa dengan isi checkpoint ini. Backup otomatis dibuat sebelum rollback.",
                        confirmLabel: "Rollback here",
                        cancelLabel: "Batal",
                        danger: true,
                      });
                      if (ok) restore.mutate(c.id);
                    }}
                  >
                    Rollback here
                  </button>
                  <button
                    className="btn-ghost text-danger text-xs"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Delete checkpoint?",
                        message: c.message,
                        confirmLabel: "Delete",
                        danger: true,
                      });
                      if (ok) del.mutate(c.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-text-muted">No checkpoints yet.</div>
          )}
        </div>
      </div>
      {filesFor && (
        <CheckpointFilesModal
          workspaceId={workspaceId}
          checkpoint={filesFor}
          onClose={() => setFilesFor(null)}
        />
      )}
    </div>
  );
}

/**
 * Read-only listing of files captured inside a single checkpoint snapshot.
 * Backed by `GET /workspaces/:id/checkpoints/:cid/files` which `tar -tzf`s
 * the .tar.gz on disk. No download/diff yet — just "what's in here".
 */
function CheckpointFilesModal({
  workspaceId,
  checkpoint,
  onClose,
}: {
  workspaceId: string;
  checkpoint: Checkpoint;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["checkpoint-files", workspaceId, checkpoint.id],
    queryFn: () =>
      API.get<{ files: string[] }>(
        `/workspaces/${workspaceId}/checkpoints/${checkpoint.id}/files`,
      ),
  });
  const files = data?.files ?? [];
  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-4"
      // stopPropagation on the backdrop too — this modal is rendered inside
      // CheckpointsModal, which closes on its OWN backdrop click. Without
      // this guard, clicking the child backdrop bubbles up and closes both.
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <div
        className="card w-full max-w-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-semibold">Changes in checkpoint</div>
            <div className="truncate text-xs text-text-muted">
              {checkpoint.message} · {new Date(checkpoint.created_at).toLocaleString()}
            </div>
          </div>
          <button className="btn-ghost p-1" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="max-h-[50vh] overflow-auto rounded-md border border-bg-border bg-bg-subtle/50 p-3 font-mono text-xs">
          {isLoading ? (
            <div className="text-text-muted">Loading…</div>
          ) : error ? (
            <div className="text-danger">
              {(error as any)?.message ?? "Failed to load file list"}
            </div>
          ) : files.length === 0 ? (
            <div className="text-text-muted">(empty)</div>
          ) : (
            <ul className="space-y-0.5">
              {files.map((f) => (
                <li key={f} className="truncate" title={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-3 text-right text-[11px] text-text-muted">
          {files.length > 0 && `${files.length} file${files.length === 1 ? "" : "s"}`}
        </div>
      </div>
    </div>
  );
}
