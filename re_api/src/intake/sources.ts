/**
 * Source adapters: the single boundary that changes when a new design-document
 * source type is added. Each adapter turns one ConstraintSource into text-only
 * ExtractedMaterial for the shared intake LLM call — keeping the backend
 * text-only (llm/client.ts sends only text content blocks). Adding a `url` or
 * `image` source later is a localized change here plus one union arm in
 * contracts.ts; the intake entry point, prompt, normalizer, route, and the
 * whole generation path stay untouched.
 */
import type { ConstraintSource } from "../contracts.ts";

/** Text-only material an adapter produces for the intake model. */
export interface ExtractedMaterial {
  /** Human-readable provenance, e.g. "brand-guide.pdf · 12 pages". */
  provenance: string;
  /** Tagged, text-only content blocks the intake LLM reads. */
  blocks: string[];
  /** Optional author instruction that steers which rules to emphasize (e.g.
   * "use the color palette in here"). Injected into the prompt, never used to
   * invent constraints the document does not state. */
  note?: string;
}

/** Thrown when a declared-but-unimplemented source type is requested. Lets the
 * route answer with a clear 400 instead of a generic failure. */
export class IntakeUnsupportedError extends Error {
  constructor(kind: string) {
    super(`INTAKE_UNSUPPORTED_SOURCE: "${kind}" intake is not implemented yet`);
    this.name = "IntakeUnsupportedError";
  }
}

export interface SourceAdapter<K extends ConstraintSource["kind"]> {
  kind: K;
  extract(source: Extract<ConstraintSource, { kind: K }>): Promise<ExtractedMaterial>;
}

function clip(text: string, limit = 40_000): string {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

/** Optional author steering note, trimmed and length-capped. Empty → omitted. */
function cleanNote(note: string | undefined): string | undefined {
  const trimmed = clip(String(note ?? ""), 500);
  return trimmed || undefined;
}

/** MVP: PDF text already extracted client-side (pdf.js) and posted as text. */
const pdfTextAdapter: SourceAdapter<"pdf-text"> = {
  kind: "pdf-text",
  async extract(source) {
    const pages = typeof source.pageCount === "number" ? `${source.pageCount} page(s)` : "text";
    const name = source.filename ? `${source.filename} · ${pages}` : `uploaded PDF · ${pages}`;
    return { provenance: name, blocks: [clip(source.text)], note: cleanNote(source.note) };
  },
};

/** MVP: raw text pasted or typed by the author. */
const rawTextAdapter: SourceAdapter<"raw-text"> = {
  kind: "raw-text",
  async extract(source) {
    return { provenance: "pasted design notes", blocks: [clip(source.text)], note: cleanNote(source.note) };
  },
};

/** Future adapter: fetch a URL and strip it to text. Pure text, so it stays a
 * localized addition — implement `extract` here, nothing else changes. */
const urlAdapter: SourceAdapter<"url"> = {
  kind: "url",
  async extract() {
    throw new IntakeUnsupportedError("url");
  },
};

/** Future adapter: a screenshot/image of a style guide. Unlike the others this
 * cannot be a pure text transform — it needs a vision content block, which
 * llm/client.ts does not send today. So enabling it is this adapter PLUS a
 * client capability. */
const imageAdapter: SourceAdapter<"image"> = {
  kind: "image",
  async extract() {
    throw new IntakeUnsupportedError("image");
  },
};

const ADAPTERS: { [K in ConstraintSource["kind"]]: SourceAdapter<K> } = {
  "pdf-text": pdfTextAdapter,
  "raw-text": rawTextAdapter,
  url: urlAdapter,
  image: imageAdapter,
};

export function adapterFor<K extends ConstraintSource["kind"]>(kind: K): SourceAdapter<K> {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new IntakeUnsupportedError(String(kind));
  return adapter;
}
