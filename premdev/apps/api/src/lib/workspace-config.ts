import fs from "node:fs";
import path from "node:path";

// Canonical config filename (Replit-style — short, no extension).
export const CONFIG_FILENAME = ".premdev";
// Legacy filename. Existing workspaces still have `.premdev.json`; we
// transparently read it as a fallback and migrate on first write.
export const LEGACY_CONFIG_FILENAME = ".premdev.json";

export type WorkspaceConfig = {
  run?: string;
  env?: Record<string, string>;
  /**
   * Force the preview to be served from this exact port inside the
   * container. Use this when the user's app hard-codes the port (e.g.
   * Flask's `app.run(port=5000)`, Django default 8000) and isn't
   * willing/able to read `os.environ["PORT"]`. Without this, PremDev
   * assigns a random port via the PORT env var and the user's app
   * binds to a different one — proxy gets ECONNREFUSED → blank page.
   */
  port?: number;
  /** Replit-style hints: copied at workspace creation, AI reads them. */
  language?: string;
  entrypoint?: string;
  modules?: string[];
};

export function configPath(workspaceDir: string): string {
  return path.join(workspaceDir, CONFIG_FILENAME);
}

export function legacyConfigPath(workspaceDir: string): string {
  return path.join(workspaceDir, LEGACY_CONFIG_FILENAME);
}

/**
 * Resolve the active config path: prefer the new `.premdev`, but fall
 * back to the legacy `.premdev.json` so workspaces created before the
 * rename keep working without manual migration.
 */
export function resolveConfigPath(workspaceDir: string): string | null {
  const p = configPath(workspaceDir);
  if (fs.existsSync(p)) return p;
  const legacy = legacyConfigPath(workspaceDir);
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

export function readWorkspaceConfig(workspaceDir: string): WorkspaceConfig | null {
  try {
    const p = resolveConfigPath(workspaceDir);
    if (!p) return null;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as WorkspaceConfig;
  } catch {
    return null;
  }
}

export const DEFAULT_CONFIG_TEMPLATE = `{
  "run": "",
  "env": {}
}
`;

export type InitialConfigInput = {
  run?: string;
  language?: string;
  entrypoint?: string;
  modules?: string[];
  env?: Record<string, string>;
};

/**
 * Build a Replit-style initial `.premdev` JSON populated from a template.
 * Including `language`, `entrypoint`, and `modules` makes it cheap for the AI
 * (and the user reading it) to understand "what is this project, how do I run it".
 */
export function buildInitialConfig(input: InitialConfigInput): string {
  const cfg: Record<string, unknown> = {};
  if (input.language) cfg.language = input.language;
  if (input.modules && input.modules.length) cfg.modules = input.modules;
  if (input.entrypoint) cfg.entrypoint = input.entrypoint;
  cfg.run = input.run ?? "";
  cfg.env = input.env ?? {};
  return JSON.stringify(cfg, null, 2) + "\n";
}

export function ensureWorkspaceConfig(workspaceDir: string, initial?: InitialConfigInput): string {
  const existing = resolveConfigPath(workspaceDir);
  if (existing) return existing;
  const p = configPath(workspaceDir);
  const body = initial ? buildInitialConfig(initial) : DEFAULT_CONFIG_TEMPLATE;
  fs.writeFileSync(p, body, "utf8");
  return p;
}

/**
 * Safely merge a partial patch into the workspace config. Existing keys not
 * mentioned in the patch are preserved. Specifically: `env` is shallow-merged
 * (so AI can set ONE new variable without nuking the rest, and so the user's
 * own secrets stored in `.premdev.json` survive an AI edit). The `run` field
 * is replaced when present in the patch.
 *
 * Returns the merged config that was written.
 */
export function patchWorkspaceConfig(
  workspaceDir: string,
  patch: { run?: string; env?: Record<string, string | null> },
): WorkspaceConfig {
  const cur = readWorkspaceConfig(workspaceDir) ?? {};
  const next: WorkspaceConfig = { ...cur };
  if (typeof patch.run === "string" && patch.run.trim()) {
    next.run = patch.run.trim();
  }
  if (patch.env && typeof patch.env === "object") {
    const merged: Record<string, string> = { ...(cur.env ?? {}) };
    for (const [k, v] of Object.entries(patch.env)) {
      if (v === null) delete merged[k]; // explicit removal
      else if (typeof v === "string") merged[k] = v;
    }
    next.env = merged;
  }
  // Migrate to the new filename whenever we write. If the workspace was
  // created with the legacy `.premdev.json`, write the new `.premdev`
  // and remove the old one in the same step so the canonical filename
  // wins on the next read.
  fs.writeFileSync(configPath(workspaceDir), JSON.stringify(next, null, 2) + "\n", "utf8");
  try {
    const legacy = legacyConfigPath(workspaceDir);
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  } catch {}
  return next;
}
