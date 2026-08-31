import test from "node:test";
import assert from "node:assert/strict";
import {
  createUndoToastController,
  UNDO_TOAST_ACTION_DURATION_MS,
  UNDO_TOAST_FEEDBACK_DURATION_MS,
} from "../src/undo-toast-controller.js";

class FakeElement extends EventTarget {
  constructor() {
    super();
    this.attributes = new Map();
    this.disabled = false;
    this.hidden = false;
    this.textContent = "";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

function createFakeClock() {
  let time = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) {
      const id = nextId++;
      tasks.set(id, { callback, due: time + delay });
      return id;
    },
    clearTimer(id) {
      tasks.delete(id);
    },
    tick(duration) {
      time += duration;
      const due = [...tasks.entries()]
        .filter(([, task]) => task.due <= time)
        .sort((a, b) => a[1].due - b[1].due);
      due.forEach(([id, task]) => {
        if (!tasks.delete(id)) return;
        task.callback();
      });
    },
  };
}

function createHarness({ onUndo = async () => true } = {}) {
  const clock = createFakeClock();
  const toast = new FakeElement();
  const titleNode = new FakeElement();
  const detailNode = new FakeElement();
  const actionButton = new FakeElement();
  const dismissButton = new FakeElement();
  const controller = createUndoToastController({
    toast,
    titleNode,
    detailNode,
    actionButton,
    dismissButton,
    onUndo,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { actionButton, clock, controller, detailNode, dismissButton, titleNode, toast };
}

test("an actionable Undo notification remains for eight seconds, then disappears", () => {
  const harness = createHarness();
  harness.controller.show({ title: "Change applied", detail: "Improve labels" });

  assert.equal(harness.toast.hidden, false);
  assert.equal(harness.actionButton.hidden, false);
  harness.clock.tick(UNDO_TOAST_ACTION_DURATION_MS - 1);
  assert.equal(harness.toast.hidden, false);
  harness.clock.tick(1);
  assert.equal(harness.toast.hidden, true);
});

test("hover and keyboard focus pause the remaining dismissal time", () => {
  const harness = createHarness();
  harness.controller.show({ title: "Change applied" });
  harness.clock.tick(3000);
  harness.toast.dispatchEvent(new Event("pointerenter"));
  harness.clock.tick(20000);
  assert.equal(harness.toast.hidden, false);

  harness.toast.dispatchEvent(new Event("pointerleave"));
  harness.clock.tick(4999);
  assert.equal(harness.toast.hidden, false);
  harness.toast.dispatchEvent(new Event("focusin"));
  harness.clock.tick(10000);
  assert.equal(harness.toast.hidden, false);
  harness.toast.dispatchEvent(new Event("focusout"));
  harness.clock.tick(1);
  assert.equal(harness.toast.hidden, true);
});

test("clicking Undo invokes the action once and exposes a pending state immediately", async () => {
  let resolveUndo;
  let calls = 0;
  const pendingUndo = new Promise((resolve) => { resolveUndo = resolve; });
  const harness = createHarness({
    onUndo: async () => {
      calls += 1;
      return pendingUndo;
    },
  });
  harness.controller.show({ title: "Change applied" });

  harness.actionButton.dispatchEvent(new Event("click", { cancelable: true }));
  harness.actionButton.dispatchEvent(new Event("click", { cancelable: true }));
  await Promise.resolve();

  assert.equal(calls, 1);
  assert.equal(harness.actionButton.disabled, true);
  assert.equal(harness.actionButton.textContent, "Undoing…");
  assert.equal(harness.toast.getAttribute("aria-busy"), "true");

  resolveUndo(true);
  await pendingUndo;
  await Promise.resolve();
});

test("non-action feedback uses the shorter standard duration", () => {
  const harness = createHarness();
  harness.controller.show({ title: "Change undone", canUndo: false });
  harness.clock.tick(UNDO_TOAST_FEEDBACK_DURATION_MS - 1);
  assert.equal(harness.toast.hidden, false);
  harness.clock.tick(1);
  assert.equal(harness.toast.hidden, true);
});
