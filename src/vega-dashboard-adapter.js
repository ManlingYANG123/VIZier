const COMPOSITION_KEYS = ["layer", "hconcat", "vconcat", "concat"];
const HOVER_MARKS = new Set(["line", "area", "trail"]);

function clone(value) {
  return structuredClone(value);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function isVegaLiteSpec(value) {
  if (!object(value)) return false;
  if (typeof value.$schema === "string" && value.$schema.includes("vega-lite")) return true;
  return value.mark !== undefined ||
    COMPOSITION_KEYS.some((key) => Array.isArray(value[key])) ||
    object(value.spec);
}

export function walkUnitSpecs(spec) {
  const units = [];
  function visit(node, path, inheritedRows = null) {
    if (!object(node)) return;
    const rows = Array.isArray(node.data?.values) ? node.data.values : inheritedRows;
    if (node.mark !== undefined) units.push({ spec: node, path, rows: rows || [] });
    for (const key of COMPOSITION_KEYS) {
      if (!Array.isArray(node[key])) continue;
      node[key].forEach((child, index) => visit(child, [...path, key, index], rows));
    }
    if (object(node.spec)) visit(node.spec, [...path, "spec"], rows);
  }
  visit(spec, []);
  return units;
}

export function specAtPath(spec, path = []) {
  let node = spec;
  for (const segment of path) {
    if (!object(node) && !Array.isArray(node)) return null;
    node = node[segment];
  }
  return object(node) ? node : null;
}

function markType(spec) {
  if (typeof spec?.mark === "string") return spec.mark;
  return object(spec?.mark) && typeof spec.mark.type === "string" ? spec.mark.type : "";
}

function encodedFields(spec) {
  if (!object(spec?.encoding)) return [];
  return Object.entries(spec.encoding).flatMap(([channel, definition]) => {
    if (!object(definition) || typeof definition.field !== "string") return [];
    return [{ channel, field: definition.field, type: definition.type }];
  });
}

function autoBounds(index, total) {
  const columns = total === 1 ? 1 : total <= 4 ? 2 : 3;
  const gap = 24;
  const left = 28;
  const top = 96;
  const width = Math.floor((1044 - gap * (columns - 1)) / columns);
  const rows = Math.ceil(total / columns);
  const height = Math.max(220, Math.floor((576 - gap * (rows - 1)) / rows));
  return {
    x: left + (index % columns) * (width + gap),
    y: top + Math.floor(index / columns) * (height + gap),
    w: width,
    h: height,
  };
}

function normalizeTiles(tiles) {
  if (!Array.isArray(tiles) || !tiles.length) {
    throw new Error("The dashboard JSON contains no Vega-Lite tiles.");
  }
  const ids = new Set();
  return tiles.map((tile, index) => {
    if (!object(tile) || !isVegaLiteSpec(tile.spec)) {
      throw new Error(`Tile ${index + 1} does not contain a valid Vega-Lite spec.`);
    }
    const id = String(tile.id || `chart-${index + 1}`);
    if (ids.has(id)) throw new Error(`Duplicate tile id: ${id}`);
    ids.add(id);
    return {
      ...tile,
      id,
      label: tile.label || tile.title || `Chart ${index + 1}`,
      v2Label: tile.v2Label || tile.label || tile.title || `Chart ${index + 1}`,
      bounds: object(tile.bounds) ? tile.bounds : autoBounds(index, tiles.length),
      renderer: "vega-lite",
      spec: clone(tile.spec),
    };
  });
}

export function isKpiTile(tile) {
  if (!object(tile) || !object(tile.spec)) return false;
  const metricName = `${tile.id || ""} ${tile.label || ""}`
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const namedAsMetric = /(?:^|[^a-z0-9])(?:kpis?|metrics?|scorecards?)(?:$|[^a-z0-9])/i
    .test(metricName);
  const units = walkUnitSpecs(tile.spec);
  const textOnly = units.length > 0 && units.every(({ spec }) => markType(spec) === "text");
  const compact = Number(tile.bounds?.h) > 0 && Number(tile.bounds.h) <= 180;
  const hasLiteralValue = units.some(({ spec }) =>
    object(spec.encoding?.text) && spec.encoding.text.value !== undefined);
  return namedAsMetric || (textOnly && compact && hasLiteralValue);
}

function normalizeDashboardFilters(filters, tiles) {
  if (!Array.isArray(filters)) return [];
  const tileIds = new Set(tiles.map((tile) => tile.id));
  return filters.slice(0, 6).flatMap((filter, index) => {
    if (!object(filter) || typeof filter.field !== "string") return [];
    const kind = filter.kind === "range" ? "range" : "category";
    const targets = Array.isArray(filter.targets)
      ? filter.targets.filter((id) => typeof id === "string" && tileIds.has(id))
      : [];
    const options = Array.isArray(filter.options)
      ? filter.options.filter((value) => typeof value === "string" || typeof value === "number").slice(0, 30)
      : undefined;
    const variants = new Set(["select", "segmented", "chips", "checkboxes", "slider"]);
    const placements = new Set(["top-row", "title-inline", "left-rail", "right-rail", "chart-header", "floating"]);
    const containers = new Set(["plain", "panel", "pill", "ruled"]);
    const tones = new Set(["neutral", "accent", "contrast"]);
    const rawPosition = object(filter.position) ? filter.position : null;
    const position = rawPosition && Number.isFinite(Number(rawPosition.x)) && Number.isFinite(Number(rawPosition.y))
      ? {
          x: Number(rawPosition.x),
          y: Number(rawPosition.y),
          ...(Number.isFinite(Number(rawPosition.w)) ? { w: Number(rawPosition.w) } : {}),
        }
      : undefined;
    const anchorTile = typeof filter.anchorTile === "string" && tileIds.has(filter.anchorTile)
      ? filter.anchorTile
      : undefined;
    const arrayValue = Array.isArray(filter.value)
      ? filter.value.filter((value) => typeof value === "string" || typeof value === "number")
      : undefined;
    const inferredVariant = kind === "range"
      ? "slider"
      : (options?.length || 0) <= 3
        ? "segmented"
        : (options?.length || 0) <= 6
          ? (targets.length > 2 ? "chips" : "checkboxes")
          : "select";
    const variant = variants.has(filter.variant) ? filter.variant : inferredVariant;
    // Never infer an overlay inside a chart. The review model sees dashboard
    // structure, not final DOM collisions, so automatically authored controls
    // must stay in reserved chrome unless a dashboard explicitly places them.
    const inferredPlacement = "top-row";
    const placement = placements.has(filter.placement) ? filter.placement : inferredPlacement;
    const inferredContainer = variant === "checkboxes"
      ? "panel"
      : variant === "chips"
        ? "pill"
        : variant === "segmented"
          ? "ruled"
          : "plain";
    const container = containers.has(filter.container) ? filter.container : inferredContainer;
    return [{
      id: String(filter.id || `dashboard-filter-${index + 1}`),
      label: String(filter.label || filter.field),
      kind,
      field: filter.field,
      targets,
      wired: filter.wired === true,
      ...(options?.length ? { options } : {}),
      ...(Number.isFinite(Number(filter.min)) ? { min: Number(filter.min) } : {}),
      ...(Number.isFinite(Number(filter.max)) ? { max: Number(filter.max) } : {}),
      ...(Number.isFinite(Number(filter.step)) ? { step: Number(filter.step) } : {}),
      ...(arrayValue?.length
        ? { value: arrayValue }
        : typeof filter.value === "string" || typeof filter.value === "number" || filter.value === null
        ? { value: filter.value }
        : {}),
      variant,
      placement,
      container,
      ...(tones.has(filter.tone) ? { tone: filter.tone } : {}),
      ...(typeof filter.accent === "string" && /^#[0-9a-f]{6}$/i.test(filter.accent)
        ? { accent: filter.accent }
        : {}),
      ...(anchorTile || placement === "chart-header" && targets[0]
        ? { anchorTile: anchorTile || targets[0] }
        : {}),
      ...(position ? { position } : {}),
    }];
  });
}

/**
 * Normalize supported JSON inputs into VIZier's dashboard contract:
 * canonical {dashboard, tiles}, provider-neutral {board, specMap}, or one raw
 * Vega-Lite spec. This is an adapter, not a sample-dashboard special case.
 */
export function normalizeDashboardDocument(data, fileName = "Dashboard") {
  if (!object(data)) throw new Error("The JSON root must be an object.");
  let dashboard;
  let tiles;

  if (object(data.dashboard) && Array.isArray(data.tiles)) {
    dashboard = { ...data.dashboard };
    tiles = data.tiles;
  } else if (object(data.specMap)) {
    dashboard = { ...(object(data.board) ? data.board : {}) };
    tiles = Object.entries(data.specMap).map(([id, spec]) => ({
      id,
      label: data.board?.tiles?.find?.((tile) => tile.id === id)?.title || id,
      spec,
    }));
  } else if (isVegaLiteSpec(data)) {
    dashboard = { title: fileName.replace(/\.json$/i, "") };
    tiles = [{ id: "dashboard-chart", label: dashboard.title, spec: data }];
  } else {
    throw new Error(
      "Expected { dashboard, tiles }, { board, specMap }, or a raw Vega-Lite spec.",
    );
  }

  const normalizedTiles = normalizeTiles(tiles);
  const hasEmbeddedKpis = normalizedTiles.some(isKpiTile);
  const filters = normalizeDashboardFilters(dashboard.filters, normalizedTiles);
  const contentWidth = Math.max(...normalizedTiles.map((tile) => tile.bounds.x + tile.bounds.w));
  const contentHeight = Math.max(...normalizedTiles.map((tile) => tile.bounds.y + tile.bounds.h));
  const kpiStyles = new Set(["editorial", "product", "compact", "technical"]);
  const kpiLayouts = new Set(["hero-support", "card-grid", "side-rail", "inline-summary"]);
  return {
    dashboard: {
      id: dashboard.id || fileName,
      title: dashboard.title || fileName.replace(/\.json$/i, ""),
      subtitle: dashboard.subtitle || "",
      hasKpis: Boolean(dashboard.hasKpis),
      hasEmbeddedKpis,
      kpis: Array.isArray(dashboard.kpis) ? dashboard.kpis : [],
      kpiStyle: kpiStyles.has(dashboard.kpiStyle) ? dashboard.kpiStyle : undefined,
      kpiLayout: kpiLayouts.has(dashboard.kpiLayout) ? dashboard.kpiLayout : undefined,
      kpiAlignment: ["start", "center", "end"].includes(dashboard.kpiAlignment) ? dashboard.kpiAlignment : undefined,
      kpiDensity: ["airy", "balanced", "dense"].includes(dashboard.kpiDensity) ? dashboard.kpiDensity : undefined,
      kpiChrome: ["plain", "ruled", "filled"].includes(dashboard.kpiChrome) ? dashboard.kpiChrome : undefined,
      kpiReservedHeight: Math.max(0, Number(dashboard.kpiReservedHeight) || 0),
      kpiReservedWidth: Math.max(0, Number(dashboard.kpiReservedWidth) || 0),
      filters,
      showChartSubtitles: Boolean(dashboard.showChartSubtitles),
      canvasWidth: Math.max(1100, Number(dashboard.canvasWidth || dashboard.width) || 0, contentWidth + 28),
      canvasHeight: Math.max(720, Number(dashboard.canvasHeight || dashboard.height) || 0, contentHeight + 28),
    },
    tiles: normalizedTiles,
  };
}

/** Turn an engine snapshot ({ specMap, board }) into the canonical dashboard
 * JSON authors can re-open in VIZier. Used to persist study checkpoints. */
export function dashboardDocumentFromSnapshot(snapshot = {}, fileName = "dashboard") {
  const board = object(snapshot?.board) ? snapshot.board : {};
  const specMap = object(snapshot?.specMap) ? snapshot.specMap : {};
  const boardTiles = Array.isArray(board.tiles) ? board.tiles : [];
  const ids = boardTiles.length
    ? boardTiles.map((tile) => tile?.id).filter((id) => typeof id === "string" && id)
    : Object.keys(specMap);
  const tiles = ids.flatMap((id) => {
    const spec = specMap[id];
    if (!isVegaLiteSpec(spec)) return [];
    const meta = boardTiles.find((tile) => tile?.id === id) || {};
    return [{
      id,
      label: meta.title || id,
      ...(object(meta.bounds) ? { bounds: clone(meta.bounds) } : {}),
      spec: clone(spec),
    }];
  });
  const optional = (key, value) => (value == null || value === "" ? {} : { [key]: value });
  return {
    dashboard: {
      id: board.id || fileName,
      title: board.title || fileName,
      subtitle: board.subtitle || "",
      hasKpis: Boolean(board.hasKpis),
      hasEmbeddedKpis: Boolean(board.hasEmbeddedKpis),
      kpis: Array.isArray(board.kpis) ? clone(board.kpis) : [],
      ...optional("kpiStyle", board.kpiStyle),
      ...optional("kpiLayout", board.kpiLayout),
      ...optional("kpiAlignment", board.kpiAlignment),
      ...optional("kpiDensity", board.kpiDensity),
      ...optional("kpiChrome", board.kpiChrome),
      kpiReservedHeight: Math.max(0, Number(board.kpiReservedHeight) || 0),
      kpiReservedWidth: Math.max(0, Number(board.kpiReservedWidth) || 0),
      filters: Array.isArray(board.filters) ? clone(board.filters) : [],
      showChartSubtitles: boardTiles.some((tile) => tile?.hasSubtitle),
      canvasWidth: Number(board.canvasWidth) || undefined,
      canvasHeight: Number(board.canvasHeight) || undefined,
    },
    tiles,
  };
}

function firstDatumForField(spec, field) {
  for (const unit of walkUnitSpecs(spec)) {
    const row = unit.rows.find((candidate) =>
      object(candidate) && candidate[field] !== undefined && candidate[field] !== null);
    if (row) return { row, unit };
  }
  const rows = Array.isArray(spec?.data?.values) ? spec.data.values : [];
  const row = rows.find((candidate) =>
    object(candidate) && candidate[field] !== undefined && candidate[field] !== null);
  return row ? { row, unit: null } : null;
}

function tooltipUnit(spec, preferredPaths = []) {
  for (const path of preferredPaths) {
    const unit = specAtPath(spec, path);
    if (unit) {
      const match = walkUnitSpecs(spec).find((entry) =>
        JSON.stringify(entry.path) === JSON.stringify(path));
      if (match) return match;
    }
  }
  return walkUnitSpecs(spec).find((entry) => HOVER_MARKS.has(markType(entry.spec))) ||
    walkUnitSpecs(spec)[0] ||
    null;
}

/**
 * Build an executable action from a critique plus the uploaded specs. All tile
 * ids, fields, values, and displayed evidence come from the artifact/critique.
 */
export function buildInteractionScenario(critique, specMap) {
  const ref = critique?.target?.ref || {};
  // The model frequently omits interactionKind even when the proposal is clearly
  // an interaction fix. Infer it from the proposal kind so a cross-filter (or its
  // show-filter-state follow-up) and a tooltip always resolve to a live scenario
  // instead of dead-ending — otherwise the "Proposed" preview looks identical to
  // "Original" and the presenting/implementing stages read as fake.
  const proposalKind = critique?.proposal?.kind;
  const kind = critique?.interactionKind
    || (proposalKind === "add-cross-filter" || proposalKind === "show-filter-state"
      ? "cross-filter"
      : proposalKind === "add-tooltip"
        ? "hover-tooltip"
        : undefined);

  if (kind === "cross-filter") {
    const sourceTile = String(ref.source || ref.tile || "");
    const sourceSpec = specMap[sourceTile];
    if (!sourceSpec) return null;
    // A cross-filter critique carries source/field/targets directly. A
    // show-filter-state follow-up carries only the source tile, so recover the
    // coordination detail from the usermeta stamped by applyCrossFilter — this
    // lets the follow-up drive the same live scenario (the persistent selection
    // it exists to make visible), instead of dead-ending with no scenario.
    const coordination = object(sourceSpec.usermeta?.crossFilter)
      ? sourceSpec.usermeta.crossFilter
      : {};
    const field = String(ref.field || coordination.field || "");
    if (!field) return null;
    const requestedTargets = Array.isArray(ref.targets)
      ? ref.targets
      : Array.isArray(coordination.targets)
        ? coordination.targets
        : [];
    const datum = firstDatumForField(sourceSpec, field);
    if (!datum) return null;
    return {
      kind,
      action: "click",
      sourceTile,
      targetTiles: requestedTargets.filter((id) => specMap[id]),
      field,
      value: datum.row[field],
      datum: clone(datum.row),
      unitPath: datum.unit?.path || [],
      showsFilterState: critique?.proposal?.kind === "show-filter-state",
    };
  }

  if (kind === "hover-tooltip") {
    const sourceTile = String(ref.tile || critique?.tileId || "");
    const sourceSpec = specMap[sourceTile];
    if (!sourceSpec) return null;
    const unit = tooltipUnit(sourceSpec, Array.isArray(ref.specPaths) ? ref.specPaths : []);
    if (!unit) return null;
    const fields = encodedFields(unit.spec).filter((entry) =>
      !["tooltip", "opacity", "detail"].includes(entry.channel));
    const row = unit.rows.find(object) || {};
    const values = fields
      .filter(({ field }) => row[field] !== undefined)
      .map(({ field }) => ({ field, value: row[field] }));
    return {
      kind,
      action: "hover",
      sourceTile,
      targetTiles: [sourceTile],
      fields: fields.map(({ field }) => field),
      values,
      datum: clone(row),
      unitPath: unit.path,
    };
  }
  return null;
}

export function applySourceSelectionState(spec, selection) {
  const next = clone(spec);
  for (const { spec: unit } of walkUnitSpecs(next)) {
    const hasField = encodedFields(unit).some(({ field, channel, type }) =>
      field === selection.field &&
      ["x", "y", "color", "theta", "column", "row"].includes(channel) &&
      (type === "nominal" || type === "ordinal"));
    if (!hasField) continue;
    unit.mark = object(unit.mark)
      ? { ...unit.mark, cursor: "pointer" }
      : { type: unit.mark, cursor: "pointer" };
    unit.encoding = {
      ...(unit.encoding || {}),
      opacity: selection.value === null || selection.value === undefined
        ? { value: 1 }
        : {
            condition: {
              test: `datum[${JSON.stringify(selection.field)}] === ${JSON.stringify(selection.value)}`,
              value: 1,
            },
            // Match the backend-installed cross-filter dim (applyCrossFilter,
            // re_api/src/apply/index.ts) so the simulated selection looks
            // identical to the state Accept actually bakes into the spec.
            value: 0.35,
          },
    };
  }
  return next;
}

function pinnedQuantitativeMax(unit, rows) {
  if (!rows.length || !["line", "area", "trail"].includes(markType(unit))) return null;
  const yField = typeof unit.encoding?.y?.field === "string" ? unit.encoding.y.field : null;
  const rawFields = new Set(rows.flatMap((row) => Object.keys(row)));
  const measures = yField && rawFields.has(yField)
    ? [yField]
    : (Array.isArray(unit.transform) ? unit.transform : [])
      .flatMap((transform) => Array.isArray(transform.fold) ? transform.fold : [])
      .filter((field) => typeof field === "string" && rawFields.has(field));
  if (!measures.length) return null;
  const xField = typeof unit.encoding?.x?.field === "string" ? unit.encoding.x.field : null;
  // Match pinnedDomainMax (re_api/src/compute/crossFilter.ts) exactly so the
  // simulated y domain equals the one Accept installs: with an x channel, take
  // the largest per-x-group sum; without one, the largest individual value
  // (NOT the sum of every row).
  let max = 0;
  for (const measure of [...new Set(measures)]) {
    if (xField) {
      const grouped = new Map();
      for (const row of rows) {
        const value = Number(row[measure]);
        if (!Number.isFinite(value)) continue;
        grouped.set(String(row[xField]), (grouped.get(String(row[xField])) || 0) + value);
      }
      for (const total of grouped.values()) max = Math.max(max, total);
    } else {
      for (const row of rows) {
        const value = Number(row[measure]);
        if (Number.isFinite(value)) max = Math.max(max, value);
      }
    }
  }
  return max > 0 ? max : null;
}

export function applyTargetFilterState(spec, selection) {
  const next = clone(spec);
  if (selection.value === null || selection.value === undefined) return next;
  const filter = {
    // Mirror the backend truth: computeCrossFilterSlice (re_api/src/compute/
    // crossFilter.ts) keeps rows where String(r[field]) === String(value).
    // Coercing both sides to a string via Vega's toString makes the simulated
    // row set identical to the slice Accept actually installs, even when the
    // field holds numbers or the clicked value's type differs from the data.
    filter: `toString(datum[${JSON.stringify(selection.field)}]) === ${JSON.stringify(String(selection.value))}`,
  };
  next.transform = [filter, ...(Array.isArray(next.transform) ? next.transform : [])];
  for (const { spec: originalUnit, path, rows } of walkUnitSpecs(spec)) {
    const pinnedMax = pinnedQuantitativeMax(originalUnit, rows);
    if (pinnedMax === null) continue;
    const targetUnit = specAtPath(next, path);
    if (!targetUnit || !object(targetUnit.encoding?.y)) continue;
    targetUnit.encoding = { ...targetUnit.encoding };
    targetUnit.encoding.y = {
      ...targetUnit.encoding.y,
      scale: {
        ...(object(targetUnit.encoding.y.scale) ? targetUnit.encoding.y.scale : {}),
        domain: [0, Math.ceil(pinnedMax * 1.05)],
      },
    };
  }
  return next;
}

export function applyDashboardFilterState(spec, controls, tileId) {
  const next = clone(spec);
  const active = (Array.isArray(controls) ? controls : []).filter((control) =>
    control?.wired &&
    control.targets?.includes(tileId) &&
    control.value !== null &&
    control.value !== undefined &&
    control.value !== ""
  );
  const transformFor = (control) => {
    if (control.kind === "range") {
      const value = Number(control.value);
      return Number.isFinite(value)
        ? { filter: `toNumber(datum[${JSON.stringify(control.field)}]) <= ${value}` }
        : null;
    }
    if (Array.isArray(control.value)) {
      const values = control.value.map((value) => String(value));
      return values.length
        ? { filter: `indexof(${JSON.stringify(values)}, toString(datum[${JSON.stringify(control.field)}])) >= 0` }
        : null;
    }
    return {
      filter: `toString(datum[${JSON.stringify(control.field)}]) === ${JSON.stringify(String(control.value))}`,
    };
  };
  for (const unit of walkUnitSpecs(next)) {
    const fields = new Set([
      ...encodedFields(unit.spec).map((entry) => entry.field),
      ...unit.rows.flatMap((row) => object(row) ? Object.keys(row) : []),
    ]);
    const transforms = active
      .filter((control) => fields.has(control.field))
      .map(transformFor)
      .filter(Boolean);
    if (!transforms.length) continue;
    const target = specAtPath(next, unit.path);
    if (target) target.transform = [...transforms, ...(Array.isArray(target.transform) ? target.transform : [])];
  }
  return next;
}
