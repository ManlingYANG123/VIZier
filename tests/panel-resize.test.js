import test from "node:test";
import assert from "node:assert/strict";
import {
  clampPanelWidth,
  clampRevisionDockHeight,
  panelWidthBounds,
  panelWidthFromKey,
  panelWidthFromPointer,
  revisionDockHeightBounds,
  revisionDockHeightFromKey,
  revisionDockHeightFromPointer,
} from "../src/panel-resize.js";

test("panel bounds preserve the center canvas before allowing a panel to grow", () => {
  assert.deepEqual(
    panelWidthBounds({
      side: "left",
      workspaceWidth: 1200,
      oppositeWidth: 360,
      handleSpace: 20,
      minCanvasWidth: 420,
    }),
    { min: 208, max: 400 },
  );
});

test("panel widths clamp to their available range", () => {
  const bounds = { min: 208, max: 440 };
  assert.equal(clampPanelWidth(120, bounds), 208);
  assert.equal(clampPanelWidth(560, bounds), 440);
  assert.equal(clampPanelWidth(317.6, bounds), 318);
});

test("pointer position maps to the panel edge being dragged", () => {
  assert.equal(
    panelWidthFromPointer({
      side: "left",
      pointerX: 320,
      workspaceLeft: 40,
      workspaceRight: 1240,
    }),
    280,
  );
  assert.equal(
    panelWidthFromPointer({
      side: "right",
      pointerX: 830,
      workspaceLeft: 40,
      workspaceRight: 1240,
    }),
    410,
  );
});

test("keyboard arrows follow the visual direction of each separator", () => {
  const bounds = { min: 208, max: 520 };
  assert.equal(panelWidthFromKey({
    side: "left",
    key: "ArrowRight",
    currentWidth: 280,
    bounds,
  }), 292);
  assert.equal(panelWidthFromKey({
    side: "right",
    key: "ArrowRight",
    currentWidth: 380,
    bounds,
  }), 368);
  assert.equal(panelWidthFromKey({
    side: "left",
    key: "Home",
    currentWidth: 280,
    bounds,
  }), 208);
  assert.equal(panelWidthFromKey({
    side: "right",
    key: "End",
    currentWidth: 380,
    bounds,
  }), 520);
});

test("revision dock bounds preserve a readable canvas above the panel", () => {
  assert.deepEqual(
    revisionDockHeightBounds({
      viewportHeight: 720,
      minCanvasHeight: 180,
    }),
    { min: 240, max: 540 },
  );
  assert.deepEqual(
    revisionDockHeightBounds({
      viewportHeight: 360,
      minCanvasHeight: 180,
    }),
    { min: 240, max: 240 },
  );
});

test("revision dock height clamps and maps vertical pointer position", () => {
  const bounds = { min: 240, max: 540 };
  assert.equal(clampRevisionDockHeight(180, bounds), 240);
  assert.equal(clampRevisionDockHeight(620, bounds), 540);
  assert.equal(revisionDockHeightFromPointer({
    pointerY: 260,
    viewportBottom: 700,
  }), 440);
});

test("revision dock keyboard controls follow vertical direction", () => {
  const bounds = { min: 240, max: 540 };
  assert.equal(revisionDockHeightFromKey({
    key: "ArrowUp",
    currentHeight: 400,
    bounds,
  }), 416);
  assert.equal(revisionDockHeightFromKey({
    key: "ArrowDown",
    currentHeight: 400,
    bounds,
  }), 384);
  assert.equal(revisionDockHeightFromKey({
    key: "Home",
    currentHeight: 400,
    bounds,
  }), 240);
  assert.equal(revisionDockHeightFromKey({
    key: "End",
    currentHeight: 400,
    bounds,
  }), 540);
});
