import type { DashboardType, Proposal, VegaLiteSpec } from "../contracts.ts";

type SpecEdit = NonNullable<Proposal["edits"]>[number];

function atPath(root: unknown, path: Array<string | number>): unknown {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function textForMarkEdit(spec: VegaLiteSpec, edit: SpecEdit): string | null {
  const markIndex = edit.path.lastIndexOf("mark");
  if (markIndex < 0) return null;
  const unit = atPath(spec, edit.path.slice(0, markIndex));
  if (!unit || typeof unit !== "object") return null;
  const encoding = (unit as Record<string, unknown>).encoding;
  if (!encoding || typeof encoding !== "object") return null;
  const text = (encoding as Record<string, unknown>).text;
  if (!text || typeof text !== "object") return null;
  const value = (text as Record<string, unknown>).value;
  return typeof value === "string" ? value : null;
}

function normalizedTokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9%]+/g) || [];
}

function tokenOverlap(before: string, after: string): number {
  const left = normalizedTokens(before);
  const right = normalizedTokens(after);
  if (!left.length || !right.length) return 0;
  const counts = new Map<string, number>();
  for (const token of left) counts.set(token, (counts.get(token) || 0) + 1);
  let shared = 0;
  for (const token of right) {
    const remaining = counts.get(token) || 0;
    if (remaining > 0) {
      shared += 1;
      counts.set(token, remaining - 1);
    }
  }
  return shared / Math.max(left.length, right.length);
}

function decadeContainsYear(decadeText: string, yearText: string): boolean {
  const decades = [...decadeText.matchAll(/\b((?:18|19|20)\d)0s\b/g)]
    .map((match) => Number(match[1]) * 10);
  const years = [...yearText.matchAll(/\b(?:18|19|20)\d{2}\b/g)]
    .map((match) => Number(match[0]));
  return decades.some((decade) => years.some((year) => year >= decade && year <= decade + 9));
}

const DIRECTIONAL_PAIRS: Array<[string, string]> = [
  ["increase", "decrease"], ["increased", "decreased"], ["increasing", "decreasing"],
  ["rise", "fall"], ["rising", "falling"], ["higher", "lower"],
  ["more", "less"], ["above", "below"], ["gain", "loss"], ["gains", "losses"],
];

function reversesMeaning(before: string, after: string): boolean {
  const left = new Set(normalizedTokens(before));
  const right = new Set(normalizedTokens(after));
  return DIRECTIONAL_PAIRS.some(([a, b]) =>
    (left.has(a) && right.has(b)) || (left.has(b) && right.has(a)));
}

function numericClaims(value: string): string[] {
  return value.match(/\b\d+(?:\.\d+)?%?\b/g) || [];
}

const ALIGNMENT_ONLY_LEAVES = new Set(["align", "x", "dx"]);

/** Reject a styling alternative that is being presented as a design defect.
 * A short narrative callout can legitimately be centered; changing only its
 * reading edge/anchor is a preference, not a material improvement. Explicit
 * author directions bypass this gate because then the change is intentional.
 */
export function lowMaterialityTextAlignmentReason({
  proposal,
  spec,
  dashboardType,
  explicitAuthorChange = false,
}: {
  proposal: Proposal;
  spec: VegaLiteSpec | undefined;
  dashboardType: DashboardType | undefined;
  explicitAuthorChange?: boolean;
}): string | null {
  if (explicitAuthorChange || !spec || proposal.kind !== "edit-spec") return null;
  if (dashboardType !== "infographic" && dashboardType !== "executive") return null;
  const edits = Array.isArray(proposal.edits) ? proposal.edits : [];
  if (!edits.length || !edits.some((edit) => edit.path.at(-1) === "align")) return null;
  if (!edits.every((edit) => ALIGNMENT_ONLY_LEAVES.has(String(edit.path.at(-1))))) return null;
  const affectedText = [...new Set(edits
    .map((edit) => textForMarkEdit(spec, edit))
    .filter((value): value is string => Boolean(value)))];
  if (!affectedText.length) return null;
  const compact = affectedText.join(" ").replace(/\s+/g, " ").trim();
  const maxLines = Math.max(...affectedText.map((value) => value.split("\n").length));
  if (compact.length > 180 || maxLines > 3) return null;
  return "alignment-only edit on a short narrative callout is an alternative style, not a material defect";
}

/** Suppress editorial microcopy polishing that does not change the dashboard's
 * interpretation. In particular, decade language and an exact year inside that
 * decade are compatible levels of precision, not contradictory evidence.
 * Real numeric corrections and directional reversals remain eligible.
 */
export function lowMaterialityTextRewriteReason({
  proposal,
  spec,
  dashboardType,
  explicitAuthorChange = false,
}: {
  proposal: Proposal;
  spec: VegaLiteSpec | undefined;
  dashboardType: DashboardType | undefined;
  explicitAuthorChange?: boolean;
}): string | null {
  if (explicitAuthorChange || !spec || proposal.kind !== "edit-spec") return null;
  if (dashboardType !== "infographic" && dashboardType !== "executive") return null;
  const edits = Array.isArray(proposal.edits) ? proposal.edits : [];
  if (!edits.length || !edits.every((edit) =>
    edit.op === "set" &&
    edit.path.length >= 3 &&
    edit.path.at(-2) === "text" &&
    edit.path.at(-1) === "value" &&
    typeof edit.value === "string"
  )) return null;
  const pairs = edits.flatMap((edit) => {
    const before = atPath(spec, edit.path);
    return typeof before === "string" && typeof edit.value === "string"
      ? [{ before, after: edit.value }]
      : [];
  });
  if (pairs.length !== edits.length) return null;
  if (pairs.some(({ before, after }) => before.length > 240 || after.length > 240)) return null;
  if (pairs.some(({ before, after }) => reversesMeaning(before, after))) return null;
  const changesDifferentNumbers = pairs.some(({ before, after }) => {
    const prior = numericClaims(before);
    const next = numericClaims(after);
    if (JSON.stringify(prior) === JSON.stringify(next)) return false;
    return !decadeContainsYear(before, after) && !decadeContainsYear(after, before);
  });
  if (changesDifferentNumbers) return null;
  const nearIdentical = pairs.every(({ before, after }) => tokenOverlap(before, after) >= 0.72);
  if (!nearIdentical) return null;
  return "near-identical microcopy rewrite does not create a material dashboard-design improvement";
}
