import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OBJECTS, PROBLEMS } from "../src/generate/review-data.ts";

/* The cluster labels are still being finalized, so slack_codebook/*_groups.csv
 * is the human design surface for the grouping. review-data.ts carries the same
 * grouping as the `category` field on each VocabEntry (the runtime source used
 * to serialize the prompt). These tests are the maintenance contract between
 * the two: edit a CSV cluster label without syncing the TS (or vice versa) and
 * the test fails, naming the exact code that drifted. */

const CODEBOOK_DIR = fileURLToPath(new URL("../../slack_codebook/", import.meta.url));

/** Minimal RFC-4180 CSV parser: handles quoted fields containing commas and
 * escaped double-quotes. Enough for the three-column groups files. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  }
  return rows;
}

/** code -> category from a groups CSV (header row `category,code,definition`). */
function categoryByCodeFromCsv(fileName: string): Map<string, string> {
  const text = readFileSync(new URL(fileName, new URL("file://" + CODEBOOK_DIR)), "utf8");
  const rows = parseCsv(text);
  const [header, ...body] = rows;
  assert.deepEqual(
    header.map((cell) => cell.trim()),
    ["category", "code", "definition"],
    `${fileName} header must be category,code,definition`,
  );
  const map = new Map<string, string>();
  for (const [category, code] of body) {
    map.set(code.trim(), category.trim());
  }
  return map;
}

function assertMatchesCsv(
  label: string,
  fileName: string,
  entries: readonly { category: string; code: string }[],
): void {
  const csv = categoryByCodeFromCsv(fileName);
  const ts = new Map(entries.map((entry) => [entry.code, entry.category]));

  // Same set of codes on both sides.
  assert.deepEqual(
    [...ts.keys()].sort(),
    [...csv.keys()].sort(),
    `${label}: the set of codes in ${fileName} must match review-data.ts`,
  );
  // Same category for each code.
  for (const [code, category] of ts) {
    assert.equal(
      category,
      csv.get(code),
      `${label}: code "${code}" is in cluster "${category}" in review-data.ts but "${csv.get(code)}" in ${fileName}`,
    );
  }
}

test("object clusters in review-data.ts match slack_codebook/object_groups.csv", () => {
  assertMatchesCsv("objects", "object_groups.csv", OBJECTS);
});

test("problem clusters in review-data.ts match slack_codebook/problem_groups.csv", () => {
  assertMatchesCsv("problems", "problem_groups.csv", PROBLEMS);
});

test("every object and problem carries a non-empty cluster", () => {
  for (const entry of OBJECTS) assert.ok(entry.category.trim().length > 0, `object ${entry.code}`);
  for (const entry of PROBLEMS) assert.ok(entry.category.trim().length > 0, `problem ${entry.code}`);
});
