import mysql from "mysql2/promise";
import { config } from "./config.js";

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool | null {
  if (!config.MYSQL_ROOT_PASSWORD) return null;
  if (!pool) {
    pool = mysql.createPool({
      host: config.MYSQL_HOST,
      port: config.MYSQL_PORT,
      user: "root",
      password: config.MYSQL_ROOT_PASSWORD,
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return pool;
}

export async function ensureMysqlUser(username: string, password: string) {
  const p = getPool();
  if (!p) return;
  const safeUser = username.replace(/[^a-zA-Z0-9_]/g, "");
  // CREATE keeps existing user if any. ALTER syncs the password so an old
  // account (created with a previous MYSQL_USER_PASSWORD or none at all)
  // accepts the credentials we now inject into workspace env vars.
  await p.query(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`, [safeUser, password]);
  await p.query(`ALTER USER ?@'%' IDENTIFIED BY ?`, [safeUser, password]);
  await p.query(`GRANT ALL PRIVILEGES ON \`${safeUser}\\_%\`.* TO ?@'%'`, [safeUser]);
  await p.query(`FLUSH PRIVILEGES`);
}

export async function createProjectDb(username: string, projectName: string) {
  const p = getPool();
  if (!p) return null;
  const safeUser = username.replace(/[^a-zA-Z0-9_]/g, "");
  const safeProj = projectName.replace(/[^a-zA-Z0-9_]/g, "_");
  const dbName = `${safeUser}_${safeProj}`;
  await p.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  return dbName;
}

export async function dropProjectDb(username: string, projectName: string) {
  const p = getPool();
  if (!p) return;
  const safeUser = username.replace(/[^a-zA-Z0-9_]/g, "");
  const safeProj = projectName.replace(/[^a-zA-Z0-9_]/g, "_");
  await p.query(`DROP DATABASE IF EXISTS \`${safeUser}_${safeProj}\``);
}

/**
 * Run a raw SQL string against the per-workspace MySQL database. The
 * caller MUST have validated the workspace ownership; this function only
 * enforces that the database name starts with `<safeUser>_` so an attacker
 * cannot smuggle a sibling user's db name. Connection is opened with the
 * workspace owner's MySQL user (created by `ensureMysqlUser`) so the
 * GRANTs we set up earlier are the actual access boundary.
 *
 * Returns at most `rowLimit` rows (default 200) and serialises BigInt to
 * string so the result is JSON-safe. SELECT, SHOW, DESCRIBE return rows;
 * INSERT/UPDATE/DELETE/DDL return an info object with affectedRows.
 */
type WorkspaceQueryRow = Record<string, unknown>;
type WorkspaceQueryResult =
  | { ok: true; kind: "rows"; columns: string[]; rows: WorkspaceQueryRow[]; rowCount: number; truncated: boolean }
  | { ok: true; kind: "info"; affectedRows: number; insertId: number; changedRows: number }
  | { ok: false; error: string };

export async function runWorkspaceQuery(opts: {
  username: string;
  dbName: string;
  sql: string;
  rowLimit?: number;
}): Promise<WorkspaceQueryResult> {
  if (!config.MYSQL_USER_PASSWORD || !config.MYSQL_HOST) {
    return { ok: false, error: "MySQL is not configured on this server" };
  }
  const safeUser = opts.username.replace(/[^a-zA-Z0-9_]/g, "");
  if (!safeUser) return { ok: false, error: "Invalid workspace owner" };
  if (!opts.dbName.startsWith(`${safeUser}_`)) {
    return { ok: false, error: `Database "${opts.dbName}" is not owned by this workspace` };
  }
  const sql = opts.sql.trim();
  if (!sql) return { ok: false, error: "Empty SQL" };
  const rowLimit = Math.max(1, Math.min(opts.rowLimit ?? 200, 1000));
  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host: config.MYSQL_HOST,
      port: config.MYSQL_PORT,
      user: safeUser,
      password: config.MYSQL_USER_PASSWORD,
      database: opts.dbName,
      multipleStatements: false,
      connectTimeout: 5_000,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    const [result, fields] = await conn.query(sql);
    if (Array.isArray(result)) {
      const fieldList = (fields ?? []) as ReadonlyArray<{ name: string }>;
      const columns = fieldList.map((f) => f.name);
      const rowsAll = result as WorkspaceQueryRow[];
      const truncated = rowsAll.length > rowLimit;
      const rows = truncated ? rowsAll.slice(0, rowLimit) : rowsAll;
      return { ok: true, kind: "rows", columns, rows, rowCount: rowsAll.length, truncated };
    }
    const info = result as { affectedRows?: number; insertId?: number; changedRows?: number };
    return {
      ok: true,
      kind: "info",
      affectedRows: Number(info.affectedRows ?? 0),
      insertId: Number(info.insertId ?? 0),
      changedRows: Number(info.changedRows ?? 0),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}
