/**
 * Study-session persistence.
 *
 * Each collected session bundle is uploaded to S3 when the study S3 config is
 * present (production / Heroku), or written to a local `data/` directory when it
 * is not (local dev). The AWS SDK is imported LAZILY so the server boots and the
 * local-fallback path works even when `@aws-sdk/client-s3` is not installed and
 * no upload is ever attempted.
 *
 * Credentials come only from environment variables (STUDY_S3_BUCKET, AWS_REGION,
 * AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) and are never sent to the browser.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** re_api/src/study-store.ts -> repo-root/data/ (same "two up" as dashboards). */
const LOCAL_DATA_DIR = fileURLToPath(new URL("../../data/", import.meta.url));

export interface StudySaveResult {
  stored: "s3" | "local";
  location: string;
  bytes: number;
  key: string;
}

/** Keep participant/session identifiers safe for use as S3 keys and file paths:
 * no separators, no traversal, bounded length. */
function safeSegment(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || fallback).slice(0, 120);
}

function s3Config(): { bucket: string; region: string } | null {
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

export async function saveStudySession(bundle: unknown): Promise<StudySaveResult> {
  const record = bundle && typeof bundle === "object" ? (bundle as Record<string, unknown>) : {};
  const participant = safeSegment(record.participantId, "unknown-participant");
  const session = safeSegment(record.sessionId, "unknown-session");
  // A unique-per-save object name so repeated Save now clicks within one
  // session do not overwrite each other — the log is append-only on disk.
  const stamp = safeSegment(record.savedAt ?? record.endedAt ?? record.bundleId, "snapshot");
  const key = `studies/${participant}/${session}/${stamp}.json`;
  const json = JSON.stringify(bundle);
  const bytes = Buffer.byteLength(json, "utf8");

  const cfg = s3Config();
  if (cfg) {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({ region: cfg.region });
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: json,
        ContentType: "application/json",
      }),
    );
    return { stored: "s3", location: `s3://${cfg.bucket}/${key}`, bytes, key };
  }

  const filePath = resolve(LOCAL_DATA_DIR, key);
  // Defence in depth: even though every segment is sanitized, never write
  // outside the data directory.
  if (filePath !== LOCAL_DATA_DIR && !filePath.startsWith(LOCAL_DATA_DIR.replace(/[/\\]?$/, sep))) {
    throw new Error("INVALID_BUNDLE: refusing to write study data outside the data directory");
  }
  await mkdir(resolve(filePath, ".."), { recursive: true });
  await writeFile(filePath, json, "utf8");
  return { stored: "local", location: filePath, bytes, key };
}
