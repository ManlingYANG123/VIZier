import { studyGroupIdFromPath } from "./study-runner-model.js";

const groupId = studyGroupIdFromPath(window.location.pathname);

if (groupId) {
  const { bootStudyRunner } = await import("./study-runner.js");
  await bootStudyRunner(groupId);
} else {
  await import("./app.js");
}

