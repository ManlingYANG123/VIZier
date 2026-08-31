import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

function startServer(port: number): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["src/server.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      RE_API_PORT: String(port),
      RE_API_HOST: "127.0.0.1",
      RE_API_DISABLE_LLM: "1",
    },
    stdio: "pipe",
  });
}

async function waitForHealth(baseUrl: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastError = "server did not start";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited during startup with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(lastError);
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("malformed JSON returns 400 without terminating the API process", async () => {
  const port = 18_000 + (process.pid % 10_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = startServer(port);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  try {
    await waitForHealth(baseUrl, child);
    for (const pathname of ["/critique", "/apply"]) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      assert.equal(response.status, 400, `${pathname} should reject malformed JSON`);
      assert.deepEqual(await response.json(), {
        error: "Malformed JSON request body",
        code: "invalid_json",
      });
      assert.equal(child.exitCode, null, `${pathname} must not terminate the API process`);
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200, `${pathname} must leave /health available`);
    }
  } catch (error) {
    assert.fail(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  } finally {
    await stopServer(child);
  }
});
