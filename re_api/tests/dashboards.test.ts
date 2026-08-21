import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DashboardLibraryError,
  listDashboardFiles,
  loadDashboardFile,
} from "../src/dashboards.ts";

async function withDashboardDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "vizier-dashboards-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("dashboard library lists valid JSON objects dynamically and in stable order", async () => {
  await withDashboardDirectory(async (directory) => {
    await writeFile(join(directory, "sales v2.json"), JSON.stringify({
      dashboard: { title: "Sales Dashboard" },
      tiles: [],
    }));
    await writeFile(join(directory, "ocean.json"), JSON.stringify({
      board: { title: "Ocean Health" },
      tiles: [],
    }));
    await writeFile(join(directory, "broken.json"), "{not-json");
    await writeFile(join(directory, "notes.txt"), "ignore");
    await mkdir(join(directory, "nested.json"));

    const dashboards = await listDashboardFiles(directory);
    assert.deepEqual(
      dashboards.map((item) => ({ id: item.id, title: item.title })),
      [
        { id: "ocean", title: "Ocean Health" },
        { id: "sales v2", title: "Sales Dashboard" },
      ],
    );
  });
});

test("dashboard library loads names with spaces and returns parsed JSON", async () => {
  await withDashboardDirectory(async (directory) => {
    await writeFile(join(directory, "workspace overview.json"), JSON.stringify({
      dashboard: { id: "workspace-overview", title: "Workspace Overview" },
      tiles: [],
    }));

    const result = await loadDashboardFile("workspace overview", directory);
    assert.equal(result.fileName, "workspace overview.json");
    assert.equal((result.dashboard.dashboard as { title: string }).title, "Workspace Overview");
  });
});

test("dashboard library rejects traversal, invalid documents, and symlinks", async () => {
  await withDashboardDirectory(async (directory) => {
    const outside = join(directory, "..", `outside-${Date.now()}.json`);
    await writeFile(outside, JSON.stringify({ dashboard: { title: "Outside" } }));
    await writeFile(join(directory, "array.json"), "[]");
    await symlink(outside, join(directory, "linked.json"));
    try {
      for (const id of ["../outside", "folder/name", "folder\\name", ".."]) {
        await assert.rejects(
          () => loadDashboardFile(id, directory),
          (error: unknown) => error instanceof DashboardLibraryError && error.status === 400,
        );
      }
      await assert.rejects(
        () => loadDashboardFile("array", directory),
        (error: unknown) => error instanceof DashboardLibraryError && error.status === 422,
      );
      await assert.rejects(
        () => loadDashboardFile("linked", directory),
        (error: unknown) => error instanceof DashboardLibraryError && error.status === 404,
      );
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("dashboard library reports oversized files and missing roots explicitly", async () => {
  await withDashboardDirectory(async (directory) => {
    await writeFile(join(directory, "oversized.json"), Buffer.alloc(5 * 1024 * 1024 + 1, 32));
    await assert.rejects(
      () => loadDashboardFile("oversized", directory),
      (error: unknown) => error instanceof DashboardLibraryError && error.status === 413,
    );
    await assert.rejects(
      () => listDashboardFiles(join(directory, "missing")),
      (error: unknown) => error instanceof DashboardLibraryError && error.status === 503,
    );
  });
});
