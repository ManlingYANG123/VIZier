export const UNDO_TOAST_ACTION_DURATION_MS = 8000;
export const UNDO_TOAST_FEEDBACK_DURATION_MS = 5000;

/**
 * Controls the actionable Undo notification without coupling its timing to the
 * dashboard mutation. The timer pauses while a pointer or keyboard focus is
 * inside the notification, then resumes with the exact time remaining.
 */
export function createUndoToastController({
  toast,
  titleNode,
  detailNode,
  actionButton,
  dismissButton,
  onUndo,
  onError = () => {},
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
}) {
  if (!toast || !titleNode || !detailNode || !actionButton || !dismissButton) {
    throw new Error("Undo toast controller requires all notification elements.");
  }

  let timer = null;
  let deadline = 0;
  let remaining = 0;
  let pointerInside = false;
  let focusInside = false;
  let undoPending = false;
  let destroyed = false;

  function clearScheduledDismiss() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    deadline = 0;
  }

  function hide() {
    clearScheduledDismiss();
    remaining = 0;
    toast.hidden = true;
    toast.removeAttribute?.("aria-busy");
  }

  function startDismissTimer(delay = remaining) {
    clearScheduledDismiss();
    remaining = Math.max(0, Number(delay) || 0);
    if (!remaining || destroyed || toast.hidden || pointerInside || focusInside || undoPending) return;
    deadline = now() + remaining;
    timer = setTimer(() => {
      timer = null;
      deadline = 0;
      remaining = 0;
      hide();
    }, remaining);
  }

  function pauseDismissTimer() {
    if (timer === null) return;
    remaining = Math.max(0, deadline - now());
    clearScheduledDismiss();
  }

  function resumeDismissTimer() {
    if (timer !== null || remaining <= 0) return;
    startDismissTimer(remaining);
  }

  function show({
    title,
    detail = "",
    canUndo = true,
    busy = false,
    duration = canUndo ? UNDO_TOAST_ACTION_DURATION_MS : UNDO_TOAST_FEEDBACK_DURATION_MS,
  }) {
    clearScheduledDismiss();
    remaining = Math.max(0, Number(duration) || 0);
    undoPending = Boolean(busy);

    titleNode.textContent = title;
    detailNode.textContent = detail;
    detailNode.hidden = !detail;
    actionButton.hidden = !canUndo;
    actionButton.disabled = !canUndo || undoPending;
    actionButton.textContent = undoPending ? "Undoing…" : "Undo";
    dismissButton.disabled = undoPending;
    toast.hidden = false;
    if (undoPending) toast.setAttribute?.("aria-busy", "true");
    else toast.removeAttribute?.("aria-busy");

    startDismissTimer(remaining);
  }

  async function invokeUndo() {
    if (destroyed || undoPending || actionButton.hidden || actionButton.disabled) return false;
    undoPending = true;
    pauseDismissTimer();
    actionButton.disabled = true;
    actionButton.textContent = "Undoing…";
    dismissButton.disabled = true;
    toast.setAttribute?.("aria-busy", "true");

    try {
      return Boolean(await onUndo?.());
    } catch (error) {
      onError(error);
      return false;
    } finally {
      undoPending = false;
      if (!toast.hidden) {
        actionButton.textContent = "Undo";
        actionButton.disabled = actionButton.hidden;
        dismissButton.disabled = false;
        toast.removeAttribute?.("aria-busy");
        resumeDismissTimer();
      }
    }
  }

  const onActionClick = (event) => {
    event.preventDefault();
    void invokeUndo();
  };
  const onDismissClick = (event) => {
    event.preventDefault();
    hide();
  };
  const onPointerEnter = () => {
    pointerInside = true;
    pauseDismissTimer();
  };
  const onPointerLeave = () => {
    pointerInside = false;
    if (!focusInside) resumeDismissTimer();
  };
  const onFocusIn = () => {
    focusInside = true;
    pauseDismissTimer();
  };
  const onFocusOut = () => {
    focusInside = false;
    if (!pointerInside) resumeDismissTimer();
  };

  actionButton.addEventListener("click", onActionClick);
  dismissButton.addEventListener("click", onDismissClick);
  toast.addEventListener("pointerenter", onPointerEnter);
  toast.addEventListener("pointerleave", onPointerLeave);
  toast.addEventListener("focusin", onFocusIn);
  toast.addEventListener("focusout", onFocusOut);

  function destroy() {
    destroyed = true;
    clearScheduledDismiss();
    actionButton.removeEventListener("click", onActionClick);
    dismissButton.removeEventListener("click", onDismissClick);
    toast.removeEventListener("pointerenter", onPointerEnter);
    toast.removeEventListener("pointerleave", onPointerLeave);
    toast.removeEventListener("focusin", onFocusIn);
    toast.removeEventListener("focusout", onFocusOut);
  }

  return {
    destroy,
    hide,
    invokeUndo,
    pause: pauseDismissTimer,
    resume: resumeDismissTimer,
    show,
  };
}
