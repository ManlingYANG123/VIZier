import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_DASHBOARD_BYTES = 5 * 1024 * 1024;

export const DEFAULT_DASHBOARDS_DIR = resolve(
  fileURLToPath(new URL("../../public/dashboards/v2/", import.meta.url)),
);

export interface DashboardLibraryItem {
  id: string;
  fileName: string;
  title: string;
  updatedAt: string;
  size: number;
}

export interface LoadedDashboard extends DashboardLibraryItem {
  dashboard: Record<string, unknown>;
}

export class DashboardLibraryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    message: string,
    status: number,
    code: string,
  ) {
    super(message);
    this.name = "DashboardLibraryError";
    this.status = status;
    this.code = code;
  }
}

function validateDashboardId(id: string): string {
  const normalized = String(id || "").trim();
  if (
    !normalized ||
    normalized.length > 200 ||
    normalized.includes("..") ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0")
  ) {
    throw new DashboardLibraryError("invalid dashboard id", 400, "invalid_dashboard_id");
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dashboardTitle(dashboard: Record<string, unknown>, fallback: string): string {
  const nestedDashboard = isRecord(dashboard.dashboard) ? dashboard.dashboard : null;
  const board = isRecord(dashboard.board) ? dashboard.board : null;
  const candidates = [nestedDashboard?.title, board?.title, dashboard.title];
  const title = candidates.find((value) => typeof value === "string" && value.trim());
  return typeof title === "string" ? title.trim().slice(0, 160) : fallback;
}

async function safeRoot(directory: string): Promise<string> {
  try {
    return await realpath(resolve(directory));
  } catch {
    throw new DashboardLibraryError(
      "dashboard library is unavailable",
      503,
      "dashboard_library_unavailable",
    );
  }
}

export async function loadDashboardFile(
  id: string,
  directory = process.env.DASHBOARDS_DIR || DEFAULT_DASHBOARDS_DIR,
): Promise<LoadedDashboard> {
  const safeId = validateDashboardId(id);
  const root = await safeRoot(directory);
  const fileName = `${safeId}.json`;
  const filePath = resolve(root, fileName);
  if (!filePath.startsWith(`${root}${sep}`)) {
    throw new DashboardLibraryError("invalid dashboard id", 400, "invalid_dashboard_id");
  }

  let stats;
  try {
    stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("not a regular file");
    const canonicalPath = await realpath(filePath);
    if (!canonicalPath.startsWith(`${root}${sep}`)) throw new Error("outside dashboard root");
  } catch {
    throw new DashboardLibraryError("dashboard not found", 404, "dashboard_not_found");
  }
  if (stats.size > MAX_DASHBOARD_BYTES) {
    throw new DashboardLibraryError("dashboard file is too large", 413, "dashboard_too_large");
  }

  let dashboard: unknown;
  try {
    dashboard = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new DashboardLibraryError("dashboard JSON is invalid", 422, "invalid_dashboard_json");
  }
  if (!isRecord(dashboard)) {
    throw new DashboardLibraryError(
      "dashboard JSON must contain an object",
      422,
      "invalid_dashboard_json",
    );
  }

  return {
    id: safeId,
    fileName,
    title: dashboardTitle(dashboard, safeId),
    updatedAt: stats.mtime.toISOString(),
    size: stats.size,
    dashboard,
  };
}

export async function listDashboardFiles(
  directory = process.env.DASHBOARDS_DIR || DEFAULT_DASHBOARDS_DIR,
): Promise<DashboardLibraryItem[]> {
  const root = await safeRoot(directory);
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5));
  const loaded = await Promise.all(candidates.map(async (id) => {
    try {
      return await loadDashboardFile(id, root);
    } catch {
      return null;
    }
  }));
  return loaded
    .filter((item): item is LoadedDashboard => item !== null)
    .map(({ dashboard: _dashboard, ...item }) => item)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
