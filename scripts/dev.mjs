import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = resolve(fileURLToPath(new URL("../", import.meta.url)));
const processes = [
  spawn(process.execPath, [resolve(appDirectory, "re_api/src/server.ts")], {
    cwd: appDirectory,
    env: process.env,
    stdio: "inherit",
  }),
  spawn(process.execPath, [
    resolve(appDirectory, "node_modules/vite/bin/vite.js"),
    "--port",
    "8082",
    "--strictPort",
  ], {
    cwd: appDirectory,
    env: process.env,
    stdio: "inherit",
  }),
];

let closing = false;
function shutdown(signal, exitCode = 0) {
  if (closing) return;
  closing = true;
  processes.forEach((child) => {
    if (!child.killed) child.kill(signal);
  });
  setTimeout(() => process.exit(exitCode), 100);
}

processes.forEach((child) => {
  child.on("error", (error) => {
    console.error(`[dev] failed to start: ${error.message}`);
    shutdown("SIGTERM", 1);
  });
  child.on("exit", (code, signal) => {
    if (!closing) {
      console.error(`[dev] process stopped (${signal || `exit ${code ?? 1}`})`);
      shutdown("SIGTERM", code ?? 1);
    }
  });
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
