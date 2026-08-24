const ACTION_EVENT = "vizier:practice-action";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function targetElement(selector) {
  if (!selector) return null;
  const candidates = [...document.querySelectorAll(selector)];
  return candidates.find((element) => {
    const rect = element.getBoundingClientRect();
    return !element.hidden && rect.width > 0 && rect.height > 0;
  }) || candidates[0] || null;
}

function targetRect(selector) {
  const target = targetElement(selector);
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  // Intersect the target with every clipping ancestor. Recommendation cards
  // live inside a scrolling right rail; using the un-clipped element rectangle
  // could draw the Step 3 frame beneath the rail's fixed controls.
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(window.innerWidth, rect.right);
  let bottom = Math.min(window.innerHeight, rect.bottom);
  let ancestor = target.parentElement;
  while (ancestor && ancestor !== document.body) {
    const style = getComputedStyle(ancestor);
    const clipsX = /(auto|scroll|hidden|clip)/.test(style.overflowX);
    const clipsY = /(auto|scroll|hidden|clip)/.test(style.overflowY);
    if (clipsX || clipsY) {
      const ancestorRect = ancestor.getBoundingClientRect();
      if (clipsX) {
        left = Math.max(left, ancestorRect.left);
        right = Math.min(right, ancestorRect.right);
      }
      if (clipsY) {
        top = Math.max(top, ancestorRect.top);
        bottom = Math.min(bottom, ancestorRect.bottom);
      }
    }
    ancestor = ancestor.parentElement;
  }
  if (right <= left || bottom <= top) return null;
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function actionMatches(action, detail) {
  if (!action?.expect || action.expect !== detail?.type) return false;
  if (typeof action.matches === "function") return Boolean(action.matches(detail));
  return true;
}

/**
 * A small, reusable product-tour runtime. Milestones determine the displayed
 * Step x of n count; each milestone can contain any number of real sub-actions.
 * The tour never clicks the product for the participant. Back/forward controls
 * always allow free review; completion marks only reflect real interactions.
 */
export function createPracticeTutorial({
  milestones,
  initialState = null,
  onActionEnter = () => {},
  onCommand = () => {},
  onComplete = () => {},
  onModeChange = () => {},
  onProgress = () => {},
}) {
  if (!Array.isArray(milestones) || !milestones.length) {
    throw new Error("Practice tutorial requires at least one milestone.");
  }

  const root = document.createElement("section");
  root.className = "practice-guide";
  root.setAttribute("aria-live", "polite");
  root.innerHTML = `
    <div class="practice-guide-spotlight" aria-hidden="true"></div>
    <aside class="practice-guide-card" role="status">
      <nav class="practice-guide-step-nav" aria-label="Tutorial navigation">
        <a class="practice-guide-back" href="#previous-guidance" aria-label="Previous guidance" title="Previous guidance">&lt;</a>
        <span class="practice-guide-kicker"></span>
        <a class="practice-guide-next" href="#next-guidance" aria-label="Next guidance" title="Next guidance">&gt;</a>
      </nav>
      <div class="practice-guide-progress" aria-hidden="true"><span></span></div>
      <h2 class="practice-guide-title"></h2>
      <p class="practice-guide-copy"></p>
      <ol class="practice-guide-actions"></ol>
      <div class="practice-guide-completion-actions" hidden>
        <button type="button" class="practice-guide-explore">Explore freely</button>
        <button type="button" class="practice-guide-review">Review tutorial</button>
      </div>
      <div class="practice-guide-footer">
        <button type="button" class="practice-guide-restart">Restart tour</button>
      </div>
    </aside>`;
  document.body.append(root);

  const modeToggle = document.createElement("button");
  modeToggle.type = "button";
  modeToggle.className = "practice-guide-mode-toggle";
  const toggleHost = document.querySelector(".top-actions");
  if (toggleHost) toggleHost.prepend(modeToggle);
  else {
    modeToggle.classList.add("is-floating");
    document.body.append(modeToggle);
  }

  const spotlight = root.querySelector(".practice-guide-spotlight");
  const card = root.querySelector(".practice-guide-card");
  const kicker = root.querySelector(".practice-guide-kicker");
  const progress = root.querySelector(".practice-guide-progress span");
  const title = root.querySelector(".practice-guide-title");
  const copy = root.querySelector(".practice-guide-copy");
  const actions = root.querySelector(".practice-guide-actions");
  const back = root.querySelector(".practice-guide-back");
  const next = root.querySelector(".practice-guide-next");
  const restart = root.querySelector(".practice-guide-restart");
  const completionActions = root.querySelector(".practice-guide-completion-actions");
  const explore = root.querySelector(".practice-guide-explore");
  const review = root.querySelector(".practice-guide-review");

  let milestoneIndex = clamp(Number(initialState?.milestoneIndex) || 0, 0, milestones.length - 1);
  let actionIndex = clamp(
    Number(initialState?.actionIndex) || 0,
    0,
    Math.max(0, (milestones[milestoneIndex]?.actions?.length || 1) - 1),
  );
  const completedOrdinals = new Set(
    (Array.isArray(initialState?.completedOrdinals) ? initialState.completedOrdinals : [])
      .map(Number)
      .filter(Number.isInteger),
  );
  let paused = Boolean(initialState?.paused);
  let completed = Boolean(initialState?.completed);
  let destroyed = false;
  let listenersAttached = false;
  let repositionFrame = 0;
  let targetTrackingFrame = 0;
  let targetTrackingSerial = 0;
  let layoutObserver = null;

  function currentMilestone() { return milestones[milestoneIndex]; }
  function currentAction() { return currentMilestone()?.actions?.[actionIndex] || null; }
  function actionOrdinal(targetMilestone = milestoneIndex, targetAction = actionIndex) {
    return milestones
      .slice(0, targetMilestone)
      .reduce((total, milestone) => total + (milestone.actions?.length || 0), 0) + targetAction;
  }
  function totalActionCount() {
    return milestones.reduce((total, milestone) => total + (milestone.actions?.length || 0), 0);
  }
  function setLinkDisabled(link, disabled) {
    link.setAttribute("aria-disabled", String(disabled));
    link.tabIndex = disabled ? -1 : 0;
  }

  function positionNow() {
    if (destroyed || paused) return;
    const action = currentAction();
    const rect = completed ? null : targetRect(action?.target);
    spotlight.hidden = !rect;
    if (rect) {
      Object.assign(spotlight.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    }

    const cardRect = card.getBoundingClientRect();
    const gap = 20;
    let left = window.innerWidth - cardRect.width - 24;
    let top = 88;
    if (rect) {
      const rightSpace = window.innerWidth - (rect.left + rect.width);
      const leftSpace = rect.left;
      if (rightSpace >= cardRect.width + gap) left = rect.left + rect.width + gap;
      else if (leftSpace >= cardRect.width + gap) left = rect.left - cardRect.width - gap;
      else left = clamp(rect.left, 18, window.innerWidth - cardRect.width - 18);

      const below = rect.top + rect.height + gap;
      const above = rect.top - cardRect.height - gap;
      if (below + cardRect.height <= window.innerHeight - 18) top = below;
      else if (above >= 18) top = above;
      else top = clamp(rect.top, 78, window.innerHeight - cardRect.height - 18);
    }
    Object.assign(card.style, {
      left: `${clamp(left, 18, window.innerWidth - cardRect.width - 18)}px`,
      top: `${clamp(top, 72, window.innerHeight - cardRect.height - 18)}px`,
    });
  }

  function position() {
    cancelAnimationFrame(repositionFrame);
    repositionFrame = requestAnimationFrame(positionNow);
  }

  // scrollIntoView can continue moving a nested critique list after it returns.
  // Follow the live target for several stable frames so the outline lands on the
  // recommendation's final rendered row instead of its pre-scroll coordinates.
  function followTargetUntilStable(selector) {
    if (destroyed || paused) return;
    cancelAnimationFrame(targetTrackingFrame);
    const serial = ++targetTrackingSerial;
    const startedAt = performance.now();
    let lastKey = "";
    let stableFrames = 0;
    const track = (now) => {
      if (destroyed || serial !== targetTrackingSerial) return;
      positionNow();
      const target = targetElement(selector);
      const targetBox = target?.getBoundingClientRect();
      const key = targetBox
        ? [targetBox.left, targetBox.top, targetBox.width, targetBox.height]
          .map((value) => Math.round(value * 10) / 10)
          .join(":")
        : "missing";
      stableFrames = key === lastKey ? stableFrames + 1 : 0;
      lastKey = key;
      const elapsed = now - startedAt;
      if (elapsed < 1200 && (elapsed < 180 || stableFrames < 8)) {
        targetTrackingFrame = requestAnimationFrame(track);
      }
    };
    targetTrackingFrame = requestAnimationFrame(track);
  }

  function render() {
    const milestone = currentMilestone();
    const action = currentAction();
    if (!milestone || !action) return;
    const subactions = milestone.actions || [];
    const tutorialStepCount = milestones.length + 1;
    const displayedStep = completed ? tutorialStepCount : milestoneIndex + 1;
    kicker.textContent = `Step ${displayedStep} of ${tutorialStepCount}`;
    const progressFraction = completed ? 1 : (milestoneIndex + 1) / tutorialStepCount;
    progress.style.transform = `scaleX(${progressFraction})`;
    title.textContent = completed ? "Done! Now try VIZier" : milestone.title;
    copy.textContent = completed
      ? "Choose how you would like to continue: explore the full tool on your own, or revisit the guided tutorial."
      : action.instruction || milestone.description || "";
    actions.hidden = completed;
    completionActions.hidden = !completed;
    restart.hidden = completed;
    actions.innerHTML = subactions.map((item, index) => {
      const ordinal = actionOrdinal(milestoneIndex, index);
      const done = completedOrdinals.has(ordinal);
      const current = index === actionIndex;
      return `
      <li class="${done ? "is-done" : ""}${current ? " is-current" : ""}">
        <span aria-hidden="true">${done ? "✓" : index + 1}</span>
        <span>${item.label || item.instruction}</span>
      </li>`;
    }).join("");
    const ordinal = actionOrdinal();
    const atEnd = ordinal === totalActionCount() - 1;
    const forwardLabel = completed
      ? "Tutorial complete"
      : action.buttonLabel || (atEnd ? "Finish tutorial" : "Next guidance");
    const backDisabled = ordinal === 0;
    setLinkDisabled(back, backDisabled);
    setLinkDisabled(next, completed);
    next.setAttribute("aria-label", forwardLabel);
    next.title = next.getAttribute("aria-label");
    onProgress({
      milestoneIndex,
      milestoneCount: milestones.length,
      actionIndex,
      actionCount: subactions.length,
      milestoneId: milestone.id,
      actionId: action.id,
      completed,
      displayedStep,
      tutorialStepCount,
    });
    Promise.resolve(onActionEnter(action, milestone)).finally(() => {
      // Reveal the real control before measuring it. Recommendation cards live
      // in a scrolling rail; measuring first left Step 3's outline at the old
      // pre-scroll coordinates.
      targetElement(action.target)?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
        behavior: "auto",
      });
      followTargetUntilStable(action.target);
    });
  }

  function advance({ markComplete = false } = {}) {
    if (completed) return;
    if (markComplete) completedOrdinals.add(actionOrdinal());
    const milestone = currentMilestone();
    if (actionIndex < (milestone.actions?.length || 0) - 1) {
      actionIndex += 1;
      render();
      return;
    }
    if (milestoneIndex < milestones.length - 1) {
      milestoneIndex += 1;
      actionIndex = 0;
      render();
      return;
    }
    completed = true;
    onComplete();
    render();
  }

  function previous() {
    if (completed) {
      completed = false;
      render();
      return;
    }
    if (actionIndex > 0) {
      actionIndex -= 1;
      render();
      return;
    }
    if (milestoneIndex > 0) {
      milestoneIndex -= 1;
      actionIndex = Math.max(0, (currentMilestone().actions?.length || 1) - 1);
      render();
    }
  }

  function handlePracticeAction(event) {
    if (!paused && actionMatches(currentAction(), event.detail)) advance({ markComplete: true });
  }

  function handleViewportChange() { position(); }

  function handleWorkspaceMutation() {
    followTargetUntilStable(currentAction()?.target);
  }

  function attachRuntimeListeners() {
    if (listenersAttached || destroyed || paused) return;
    listenersAttached = true;
    document.addEventListener(ACTION_EVENT, handlePracticeAction);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("scrollend", handleViewportChange, true);
    if (typeof MutationObserver === "function") {
      layoutObserver = new MutationObserver(handleWorkspaceMutation);
      layoutObserver.observe(document.getElementById("app") || document.body, {
        childList: true,
        subtree: true,
      });
    }
  }

  function detachRuntimeListeners() {
    if (!listenersAttached) return;
    listenersAttached = false;
    document.removeEventListener(ACTION_EVENT, handlePracticeAction);
    window.removeEventListener("resize", handleViewportChange);
    window.removeEventListener("scroll", handleViewportChange, true);
    window.removeEventListener("scrollend", handleViewportChange, true);
    layoutObserver?.disconnect();
    layoutObserver = null;
  }

  function syncModeToggle() {
    modeToggle.dataset.mode = paused ? "explore" : "tutorial";
    modeToggle.textContent = paused ? "Resume tutorial" : "Explore freely";
    modeToggle.setAttribute("aria-label", paused
      ? "Resume the guided tutorial"
      : "Pause the tutorial and explore VIZier freely");
  }

  function setPaused(nextPaused) {
    if (destroyed || paused === Boolean(nextPaused)) return;
    paused = Boolean(nextPaused);
    targetTrackingSerial += 1;
    cancelAnimationFrame(repositionFrame);
    cancelAnimationFrame(targetTrackingFrame);
    root.hidden = paused;
    if (paused) detachRuntimeListeners();
    else {
      attachRuntimeListeners();
      render();
    }
    syncModeToggle();
    onModeChange({
      mode: paused ? "explore" : "tutorial",
      milestoneIndex,
      actionIndex,
      milestoneId: currentMilestone()?.id,
      actionId: currentAction()?.id,
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    targetTrackingSerial += 1;
    cancelAnimationFrame(repositionFrame);
    cancelAnimationFrame(targetTrackingFrame);
    detachRuntimeListeners();
    root.remove();
    modeToggle.remove();
  }

  function getState() {
    return {
      milestoneIndex,
      actionIndex,
      completedOrdinals: [...completedOrdinals].sort((a, b) => a - b),
      paused,
      milestoneId: currentMilestone()?.id || null,
      actionId: currentAction()?.id || null,
      completed,
    };
  }

  function start() {
    syncModeToggle();
    root.hidden = paused;
    if (!paused) {
      attachRuntimeListeners();
      render();
    }
  }

  back.addEventListener("click", (event) => {
    event.preventDefault();
    if (back.getAttribute("aria-disabled") !== "true") previous();
  });
  next.addEventListener("click", (event) => {
    event.preventDefault();
    if (next.getAttribute("aria-disabled") !== "true") {
      advance({ markComplete: !currentAction()?.expect });
    }
  });
  modeToggle.addEventListener("click", () => setPaused(!paused));
  explore.addEventListener("click", () => setPaused(true));
  review.addEventListener("click", () => {
    completed = false;
    milestoneIndex = 0;
    actionIndex = 0;
    render();
  });
  restart.addEventListener("click", async () => {
    milestoneIndex = 0;
    actionIndex = 0;
    completed = false;
    completedOrdinals.clear();
    await onCommand("restart-tutorial", currentAction());
    render();
  });

  return {
    start,
    destroy,
    restart: () => restart.click(),
    setPaused,
    isPaused: () => paused,
    getState,
  };
}
