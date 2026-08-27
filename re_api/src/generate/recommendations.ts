import { readFileSync } from "node:fs";
import type { Dimension } from "../contracts.ts";

/** Ordered list of the 11 recommendation branches (display/grouping order). */
export const RECOMMENDATION_BRANCHES = [
  "chart",
  "color",
  "layout",
  "data",
  "text",
  "visual design",
  "cognition",
  "context",
  "interaction",
  "task",
  "design process",
] as const satisfies readonly Dimension[];

const RECOMMENDATION_BRANCH_SET = new Set<string>(RECOMMENDATION_BRANCHES);
const RECOMMENDATION_CSV_URL = new URL(
  "../../../slack_codebook/recommendation_v3_examples.csv",
  import.meta.url,
);
const MAX_EXAMPLE_CHARS = 640;

/** PRESENTING catalog leaf loaded from recommendation_v3_examples.csv.
 * The CSV is the single source of truth for ids, definitions, and empirical
 * few-shot examples; restart the API after editing it to reload the catalog. */
export interface RecommendationLeaf {
  /** Canonical `<branch>:<leaf>` id. */
  id: string;
  branch: Dimension;
  leaf: string;
  definition: string;
  /** Natural-language feedback excerpts mapped to this recommendation. */
  examples: readonly string[];
}

function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    if (quoted) {
      if (char === '"' && csvText[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && csvText[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error("Unterminated quoted field in recommendation CSV");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizedHeader(value: string): string {
  return compactText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Parse and validate the maintainable CSV source. Blank separator rows and
 * non-semantic columns are ignored; every `Example N` column is discovered by
 * header name so example text can change without touching engine code. */
export function parseRecommendationCsv(csvText: string): RecommendationLeaf[] {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) throw new Error("Recommendation CSV is empty");

  const headers = rows[0].map(normalizedHeader);
  const codeIndex = headers.indexOf("code");
  const definitionIndex = headers.indexOf("definition");
  const exampleIndices = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => /^example\d+$/.test(header))
    .sort((left, right) => Number(left.header.slice(7)) - Number(right.header.slice(7)))
    .map(({ index }) => index);

  if (codeIndex < 0 || definitionIndex < 0) {
    throw new Error("Recommendation CSV must contain code and definition columns");
  }
  if (exampleIndices.length === 0) {
    throw new Error("Recommendation CSV must contain at least one Example N column");
  }

  const leaves: RecommendationLeaf[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    const rawCode = compactText(row[codeIndex] ?? "");
    if (!rawCode) continue;
    const separator = rawCode.indexOf(":");
    if (separator <= 0 || separator === rawCode.length - 1) {
      throw new Error(`Invalid recommendation code: ${rawCode}`);
    }

    const branch = compactText(rawCode.slice(0, separator)).toLowerCase();
    const leaf = compactText(rawCode.slice(separator + 1)).toLowerCase();
    const id = `${branch}:${leaf}`;
    const definition = compactText(row[definitionIndex] ?? "");
    if (!RECOMMENDATION_BRANCH_SET.has(branch)) {
      throw new Error(`Unknown recommendation branch in ${rawCode}: ${branch}`);
    }
    if (!definition) throw new Error(`Missing definition for recommendation ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate recommendation code: ${id}`);
    seen.add(id);

    const examples = exampleIndices
      .map((index) => compactText(row[index] ?? ""))
      .filter(Boolean);
    leaves.push(Object.freeze({
      id,
      branch: branch as Dimension,
      leaf,
      definition,
      examples: Object.freeze(examples),
    }));
  }

  if (leaves.length === 0) throw new Error("Recommendation CSV contains no recommendation rows");
  return leaves;
}

export const RECOMMENDATION_LEAVES: readonly RecommendationLeaf[] = Object.freeze(
  parseRecommendationCsv(readFileSync(RECOMMENDATION_CSV_URL, "utf8")),
);

/** Fast lookup of a leaf by its canonical `<branch>:<leaf>` id. */
export const RECOMMENDATION_LEAF_BY_ID: ReadonlyMap<string, RecommendationLeaf> =
  new Map(RECOMMENDATION_LEAVES.map((leaf) => [leaf.id, leaf]));

/** True when `id` is a known recommendation leaf. PRESENTING selects one of
 * these freely; the id is validated but the branch it belongs to never gates
 * which object×problem diagnosis may prescribe it. */
export function isRecommendationLeafId(id: string): boolean {
  return RECOMMENDATION_LEAF_BY_ID.has(id);
}

function promptExample(value: string): string {
  return value.length <= MAX_EXAMPLE_CHARS
    ? value
    : `${value.slice(0, MAX_EXAMPLE_CHARS - 1).trimEnd()}…`;
}

/** Catalog and empirical few-shot block for the model. Every leaf is grouped
 * under its branch; examples teach semantic mapping and feedback specificity,
 * while the system prompt prevents copying their artifact-specific details. */
export function recommendationCatalogPrompt(): string {
  const byBranch = new Map<Dimension, RecommendationLeaf[]>();
  for (const leaf of RECOMMENDATION_LEAVES) {
    const list = byBranch.get(leaf.branch) ?? [];
    list.push(leaf);
    byBranch.set(leaf.branch, list);
  }
  const lines: string[] = [];
  for (const branch of RECOMMENDATION_BRANCHES) {
    const leaves = byBranch.get(branch);
    if (!leaves || leaves.length === 0) continue;
    lines.push(`[${branch}]`);
    for (const leaf of leaves) {
      lines.push(`  - ${leaf.id} — ${leaf.definition}`);
      if (leaf.examples.length > 0) {
        lines.push("    Empirical feedback examples (few-shot mapping cues):");
        leaf.examples.forEach((example, index) => {
          lines.push(`      ${index + 1}. ${promptExample(example)}`);
        });
      }
    }
  }
  return lines.join("\n");
}

/** Production catalog without the repeated empirical excerpts. Every exact
 * leaf id and definition remains available to the model; the full examples stay
 * available through recommendationCatalogPrompt() for offline analysis. */
export function recommendationCatalogDefinitionsPrompt(): string {
  const byBranch = new Map<Dimension, RecommendationLeaf[]>();
  for (const leaf of RECOMMENDATION_LEAVES) {
    const list = byBranch.get(leaf.branch) ?? [];
    list.push(leaf);
    byBranch.set(leaf.branch, list);
  }
  const lines: string[] = [];
  for (const branch of RECOMMENDATION_BRANCHES) {
    const leaves = byBranch.get(branch);
    if (!leaves?.length) continue;
    lines.push(`[${branch}]`);
    for (const leaf of leaves) lines.push(`  - ${leaf.id} — ${leaf.definition}`);
  }
  return lines.join("\n");
}
