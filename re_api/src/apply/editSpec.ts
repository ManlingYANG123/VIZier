/**
 * The general executable primitive: apply model-proposed JSON edits to a
 * Vega-Lite tile spec. Because the whole spec is in the JSON, most catalog
 * recommendations (chart form, color, text/labels, axes, sort, scale, spacing,
 * legends, spec-internal layout) reduce to a small set of path-addressed
 * set/remove operations. This bridges the recommendation catalog to real
 * executable transforms without a bespoke function per leaf.
 *
 * Trust invariant (agent proposes -> engine applies -> UI shows before/after):
 * the engine, not the model, is the trusted applier. Every edit is sanitized
 * against the tile's own data before it touches the spec:
 *   - it may never fabricate data (no writes into data/datasets, no inline
 *     `data`/`values` payloads in a set value);
 *   - it may never invent a field (any `field:` it introduces must already be a
 *     real column of this tile);
 *   - it may never rewire engine-owned coordination (usermeta) or raw
 *     selections (params) — those flow only through the specialized transforms.
 * Whatever survives sanitization is still run through the compile gate in
 * validate.ts and rolled back on failure, so a structurally invalid edit can
 * never be adopted.
 */
import type { VegaLiteSpec } from "../contracts.ts";
import { dataColumnsDeep, encodedFieldsDeep } from "../detect/specUtil.ts";

export interface SpecEdit {
  op: "set" | "remove";
  /** Address inside the tile spec, e.g. ["encoding","x","sort"] or
   * ["vconcat",0,"layer",0,"mark","point"]. */
  path: Array<string | number>;
  /** Present for op "set"; ignored for "remove". */
  value?: unknown;
}

/** Top-level keys an edit may never enter — data provenance, engine-owned
 * coordination state, and root geometry. `width`/`height`/`autosize` are
 * forbidden because `renderTile` (src/app.js) overwrites all three on every
 * render — the tile is sized from its layout `bounds`, not from the spec — so an
 * edit that touches only them applies cleanly server-side yet can never be seen:
 * the "Fixable, accepted, but nothing changed" symptom. Resizing a tile is a
 * layout/bounds operation, not a spec edit. Note this guards only the ROOT keys
 * (path[0]); an inner unit's width/height (e.g. ["vconcat",0,"width"]) is a real
 * visible lever and stays allowed. Everything else (encoding, mark, transform,
 * config, title, resolve, spacing, ...) is fair game. */
const FORBIDDEN_ROOT_KEYS = new Set([
  "data", "datasets", "usermeta", "params", "$schema", "width", "height", "autosize",
]);
const MAX_EDITS = 24;
const MAX_PATH_LENGTH = 12;

/** Every field name the tile can legitimately reference (encoded or a real
 * inline-data column). A `field:` outside this set would be fabricated. */
export function realFieldsOf(spec: VegaLiteSpec): Set<string> {
  const fields = new Set<string>(dataColumnsDeep(spec));
  for (const encoded of encodedFieldsDeep(spec)) fields.add(encoded.field);
  return fields;
}

/** Field names the edits themselves introduce via transform `as` outputs.
 *
 * A genuine chart-form change is often two steps: add a transform that DERIVES a
 * new field (calculate / aggregate / bin / timeUnit / window / fold / lookup /
 * joinaggregate / stack — every one names its output with `as`, a string or an
 * array of strings), then encode that derived field. Counting only pre-existing
 * fields rejects the encode step and collapses the whole edit to guidance, which
 * is a major source of homogenized reviews (the model can only ever restyle
 * fields that are already on the chart, never restructure one).
 *
 * A derived field is not fabricated data: it is computed from the tile's real
 * columns, and the data/datasets keys stay forbidden (valueIsSafe), so no inline
 * source rows can enter this way. The transform's own inputs are the model's
 * responsibility, guarded — like every edit — by the compile + rollback gate.
 * An encoding that references neither a real column nor a declared `as` output
 * is still rejected as fabricated. */
export function derivedFieldsFrom(edits: unknown): Set<string> {
  const names = new Set<string>();
  const computationKeys = new Set([
    "calculate", "aggregate", "joinaggregate", "window", "bin", "timeUnit",
    "fold", "lookup", "stack", "flatten", "density", "quantile", "regression",
    "loess", "impute", "pivot", "sample",
  ]);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      // Trust an `as` output only when it ACCOMPANIES a computation directive
      // (calculate / op / field / fold / ...). Every real transform step carries
      // a sibling key besides `as`; a bare {"as":"x"} computes nothing, so it
      // must not be able to bless an otherwise-unknown field name. This keeps the
      // two-step derive-then-encode fix working while closing the only path that
      // would register a derived name no transform actually produces.
      const computesValue = Object.keys(value).some((candidate) => computationKeys.has(candidate));
      if (key === "as" && computesValue) {
        if (typeof nested === "string") names.add(nested);
        else if (Array.isArray(nested)) for (const n of nested) if (typeof n === "string") names.add(n);
      }
      walk(nested);
    }
  };
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (!isPlainObject(edit)) continue;
      const path = (edit as Record<string, unknown>).path;
      if (Array.isArray(path) && path.includes("transform")) {
        walk((edit as Record<string, unknown>).value);
      }
    }
  }
  return names;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A set value may not fabricate data or reference an unknown field anywhere in
 * its (possibly nested) structure. */
function valueIsSafe(value: unknown, realFields: Set<string>): boolean {
  if (Array.isArray(value)) return value.every((item) => valueIsSafe(item, realFields));
  if (!isPlainObject(value)) return true;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "data" || key === "datasets") return false; // no inline data payloads
    if (key === "field" && typeof nested === "string" && !realFields.has(nested)) return false;
    if (!valueIsSafe(nested, realFields)) return false;
  }
  return true;
}

function isValidPath(path: unknown): path is Array<string | number> {
  return Array.isArray(path) &&
    path.length > 0 &&
    path.length <= MAX_PATH_LENGTH &&
    path.every((segment) =>
      (typeof segment === "string" && segment.length > 0) ||
      (typeof segment === "number" && Number.isInteger(segment) && segment >= 0));
}

/** True when a single edit is structurally well-formed and cannot fabricate. */
export function editIsSafe(edit: unknown, realFields: Set<string>): edit is SpecEdit {
  if (!isPlainObject(edit)) return false;
  const { op, path } = edit as Record<string, unknown>;
  if (op !== "set" && op !== "remove") return false;
  if (!isValidPath(path)) return false;
  if (FORBIDDEN_ROOT_KEYS.has(String((path as Array<string | number>)[0]))) return false;
  if (op === "set") {
    if (!("value" in (edit as Record<string, unknown>))) return false;
    const value = (edit as Record<string, unknown>).value;
    if (!valueIsSafe(value, realFields)) return false;
    // Symmetric field guard for the path-addressed form. Setting ["...","field"]
    // to a bare STRING writes an encoding field exactly as an object value
    // {field:"..."} does, but a bare string always passes valueIsSafe (only the
    // "field" KEY inside an object value is checked there). This is the form the
    // derive-then-encode route uses ({path:["encoding","y","field"],value:"profit"}),
    // so gate it the same way: the field must be a real column or one the edits'
    // own transform derives, else it is a fabricated reference and is dropped.
    const p = path as Array<string | number>;
    if (p[p.length - 1] === "field" && typeof value === "string" && !realFields.has(value)) return false;
  }
  return true;
}

/** Keep only the edits that are safe to apply to this tile. */
export function safeSpecEdits(spec: VegaLiteSpec, edits: unknown): SpecEdit[] {
  if (!Array.isArray(edits)) return [];
  // Real columns/encodings of the tile PLUS any field the edit set derives via a
  // transform `as` — so a two-step "derive then encode" fix survives while a
  // reference to a truly unknown field is still dropped as fabricated.
  const realFields = new Set<string>([...realFieldsOf(spec), ...derivedFieldsFrom(edits)]);
  const safe: SpecEdit[] = [];
  for (const edit of edits.slice(0, MAX_EDITS)) {
    if (editIsSafe(edit, realFields)) safe.push({ op: edit.op, path: [...edit.path], ...(edit.op === "set" ? { value: edit.value } : {}) });
  }
  return safe;
}

/** Structural equality for spec fragments — order-independent for objects (key
 * order carries no meaning in a Vega-Lite spec) and order-sensitive for arrays.
 * Used so a set that writes the value already present is reported as no change. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/** Set `value` at `path`, creating intermediate containers. Returns true only
 * when the spec actually changed: setting a leaf to the value it already holds
 * is a no-op and must not be counted as an applied edit (otherwise the change is
 * reported to the UI but the spec is byte-identical). */
function setAtPath(root: Record<string | number, unknown>, path: Array<string | number>, value: unknown): boolean {
  let node: Record<string | number, unknown> = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const nextKey = path[i + 1];
    const existing = node[key];
    if (!existing || typeof existing !== "object") {
      node[key] = typeof nextKey === "number" ? [] : {};
    }
    node = node[key] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1];
  if (Object.prototype.hasOwnProperty.call(node, last) && deepEqual(node[last], value)) return false;
  node[last] = value;
  return true;
}

/** Remove the leaf at `path`. Returns true only when something was actually
 * removed: a remove of a path that does not exist is a no-op and must not be
 * counted (otherwise a phantom remove dodges the APPLY_NO_CHANGE guard). */
function removeAtPath(root: Record<string | number, unknown>, path: Array<string | number>): boolean {
  let node: Record<string | number, unknown> = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const existing = node[path[i]];
    if (!existing || typeof existing !== "object") return false; // parent missing -> nothing to remove
    node = existing as Record<string | number, unknown>;
  }
  const last = path[path.length - 1];
  if (Array.isArray(node)) {
    if (typeof last === "number" && last >= 0 && last < node.length) {
      node.splice(last, 1);
      return true;
    }
    return false; // out-of-range or non-index key on an array -> nothing removed
  }
  if (Object.prototype.hasOwnProperty.call(node, last)) {
    delete node[last];
    return true;
  }
  return false; // key absent -> nothing removed
}

/**
 * Apply the (already-sanitized) edits to the spec in place. Returns true when at
 * least one edit produced a real change. A set to an identical value or a remove
 * of a missing path is a no-op and is NOT counted, so a critique whose every
 * edit no-ops honestly reports "no change" (APPLY_NO_CHANGE) instead of claiming
 * a fix the canvas can't show. Sanitization is re-run here so /apply is safe even
 * when the critique arrives from an untrusted client.
 */
export function applySpecEdits(spec: VegaLiteSpec, edits: unknown): boolean {
  const safe = safeSpecEdits(spec, edits);
  const root = spec as Record<string | number, unknown>;
  let applied = 0;
  for (const edit of safe) {
    const changed = edit.op === "set"
      ? setAtPath(root, edit.path, edit.value)
      : removeAtPath(root, edit.path);
    if (changed) applied += 1;
  }
  return applied > 0;
}
