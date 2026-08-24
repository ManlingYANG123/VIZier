/**
 * Study-session persistence.
 *
 * Each collected session bundle is uploaded to S3 when the study S3 config is
 * present (production / Heroku), or written to a local `data/` directory when it
 * is not (local dev). The AWS SDK is imported LAZILY so the server boots and the
 * local-fallback path works even when `@aws-sdk/client-s3` is not installed and
 * no upload is ever attempted.
 *
 * On End & save the client also sends dashboard artifacts (high-resolution PNG
 * + reloadable JSON), protocol questionnaire records, and runner state. Those
 * are stored as sibling files rather than embedded in the event-log JSON.
 *
 * Credentials come only from environment variables (STUDY_S3_BUCKET, AWS_REGION,
 * AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) and are never sent to the browser.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** re_api/src/study-store.ts -> repo-root/data/ (same "two up" as dashboards). */
const DEFAULT_LOCAL_DATA_DIR = fileURLToPath(new URL("../../data/", import.meta.url));
const MAX_ARTIFACTS = 48;
const MAX_ARTIFACT_BYTES = 12 * 1024 * 1024;

export interface StudySaveResult {
  stored: "s3" | "local";
  location: string;
  bytes: number;
  key: string;
  files: string[];
}

type StudyArtifact = {
  path?: unknown;
  contentType?: unknown;
  text?: unknown;
  encoding?: unknown;
  data?: unknown;
};

/** Keep participant/session identifiers safe for use as S3 keys and file paths:
 * no separators, no traversal, bounded length. */
function safeSegment(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || fallback).slice(0, 120);
}

function jsonFileName(record: Record<string, unknown>): string {
  const raw = String(record.fileName || "").replace(/\\/g, "/").split("/").pop() || "";
  const stem = safeSegment(raw.replace(/\.json$/i, ""), "");
  if (stem) return `${stem}.json`;
  const stamp = safeSegment(String(record.savedAt || record.endedAt || "snapshot").replace(/:/g, "-"), "snapshot");
  const phase = safeSegment(record.phase || record.reason || "record", "record");
  return `${phase}-${stamp}.json`;
}

function localDataDir(): string {
  const override = process.env.STUDY_DATA_DIR?.trim();
  return override ? resolve(override) : DEFAULT_LOCAL_DATA_DIR;
}

function s3Config(): { bucket: string; region: string } | null {
  if (process.env.STUDY_FORCE_LOCAL === "1") return null;
  const bucket = process.env.STUDY_S3_BUCKET?.trim();
  const region = process.env.AWS_REGION?.trim();
  if (!bucket || !region) return null;
  // Explicit credentials are required; refuse to silently fall back to an
  // ambient/instance role we did not intend to use for participant data.
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) return null;
  return { bucket, region };
}

export function studyStorageMode(): "s3" | "local" {
  return s3Config() ? "s3" : "local";
}

function safeArtifactPath(raw: unknown): string {
  const text = String(raw ?? "").replace(/\\/g, "/").trim();
  const parts = text.split("/").filter(Boolean);
  const isRunnerState = text === "study-runner-state.json";
  const isScopedArtifact = ["dashboards", "questionnaires"].includes(parts[0])
    && parts.length >= 2
    && parts.length <= 4;
  if (!isRunnerState && !isScopedArtifact) {
    throw new Error("INVALID_BUNDLE: study artifacts must be runner state, dashboards, or questionnaires");
  }
  if (parts.some((part) => part === "." || part === ".." || part.includes(".."))) {
    throw new Error("INVALID_BUNDLE: study artifact path is not allowed");
  }
  const cleaned = parts.map((part) => safeSegment(part, ""));
  if (cleaned.some((part) => !part)) {
    throw new Error("INVALID_BUNDLE: study artifact path is not allowed");
  }
  return cleaned.join("/");
}

function artifactBody(artifact: StudyArtifact): { bytes: Buffer; contentType: string } {
  const contentType = String(artifact.contentType || "application/octet-stream");
  if (artifact.encoding === "base64" && typeof artifact.data === "string") {
    const bytes = Buffer.from(artifact.data, "base64");
    if (!bytes.length && artifact.data.length) {
      throw new Error("INVALID_BUNDLE: study artifact is not valid base64");
    }
    return { bytes, contentType };
  }
  return {
    bytes: Buffer.from(String(artifact.text ?? ""), "utf8"),
    contentType: contentType.includes("json") ? "application/json" : contentType,
  };
}

async function putObject(input: {
  key: string;
  body: Buffer | string;
  contentType: string;
}): Promise<"s3" | "local"> {
  const cfg = s3Config();
  if (cfg) {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({ region: cfg.region });
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
    return "s3";
  }

  const root = localDataDir();
  const filePath = resolve(root, input.key);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (filePath !== root && !filePath.startsWith(prefix)) {
    throw new Error("INVALID_BUNDLE: refusing to write study data outside the data directory");
  }
  await mkdir(resolve(filePath, ".."), { recursive: true });
  await writeFile(filePath, input.body);
  return "local";
}

export async function saveStudySession(bundle: unknown): Promise<StudySaveResult> {
  const record = bundle && typeof bundle === "object" ? { ...(bundle as Record<string, unknown>) } : {};
  const participant = safeSegment(record.participantId, "unknown-participant");
  const session = safeSegment(record.sessionId, "unknown-session");
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts as StudyArtifact[] : [];
  if (artifacts.length > MAX_ARTIFACTS) {
    throw new Error("INVALID_BUNDLE: too many study artifacts");
  }
  delete record.artifacts;
  const prepared: { relative: string; bytes: Buffer; contentType: string }[] = [];
  for (const artifact of artifacts) {
    const relative = safeArtifactPath(artifact.path);
    const { bytes, contentType } = artifactBody(artifact);
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      console.warn(`[study-store] skipping oversized artifact ${relative} (${bytes.length} bytes)`);
      continue;
    }
    prepared.push({ relative, bytes, contentType });
  }
  record.artifactFiles = prepared.map((item) => item.relative);

  const key = `studies/${participant}/${session}/${jsonFileName(record)}`;
  const json = JSON.stringify(record);
  const bytes = Buffer.byteLength(json, "utf8");
  const files = [key];

  const stored = await putObject({ key, body: json, contentType: "application/json" });
  for (const artifact of prepared) {
    const artifactKey = `studies/${participant}/${session}/${artifact.relative}`;
    await putObject({ key: artifactKey, body: artifact.bytes, contentType: artifact.contentType });
    files.push(artifactKey);
  }

  const location = stored === "s3"
    ? `s3://${s3Config()?.bucket}/${key}`
    : resolve(localDataDir(), key);
  return { stored, location, bytes, key, files };
}
