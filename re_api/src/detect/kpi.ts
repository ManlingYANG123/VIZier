import type { BoardMeta, Bounds, SpecMap, VegaLiteSpec } from "../contracts.ts";

const COMPOSITION_KEYS = ["layer", "hconcat", "vconcat", "concat"];

function metricName(value: string): boolean {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return /(?:^|[^a-z0-9])(?:kpis?|metrics?|scorecards?)(?:$|[^a-z0-9])/i.test(spaced);
}

function textOnlyLiteralMetric(spec: VegaLiteSpec, bounds?: Bounds): boolean {
  if (!bounds || bounds.h > 180) return false;
  const marks: string[] = [];
  let hasLiteralText = false;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    const mark = node.mark;
    if (typeof mark === "string") marks.push(mark);
    else if (mark && typeof mark === "object" && !Array.isArray(mark) &&
        typeof (mark as Record<string, unknown>).type === "string") {
      marks.push((mark as Record<string, unknown>).type as string);
    }
    const encoding = node.encoding;
    if (encoding && typeof encoding === "object" && !Array.isArray(encoding)) {
      const text = (encoding as Record<string, unknown>).text;
      if (text && typeof text === "object" && !Array.isArray(text) &&
          (text as Record<string, unknown>).value !== undefined) hasLiteralText = true;
    }
    for (const key of COMPOSITION_KEYS) {
      const children = node[key];
      if (Array.isArray(children)) children.forEach(visit);
    }
    visit(node.spec);
  };
  visit(spec);
  return marks.length > 0 && marks.every((mark) => mark === "text") && hasLiteralText;
}

export function hasEmbeddedKpis(specMap: SpecMap, board?: BoardMeta): boolean {
  if (board?.hasEmbeddedKpis) return true;
  return Object.entries(specMap).some(([id, spec]) => {
    const tile = board?.tiles?.find((candidate) => candidate.id === id);
    return metricName(`${id} ${tile?.title || ""}`) ||
      textOnlyLiteralMetric(spec, tile?.bounds);
  });
}
