import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicReplaceFile } from "../src/atomic-file.ts";

async function temporary(t, label) {
  const directory = await mkdtemp(join(tmpdir(), label));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("atomic replacement makes the complete new content current", async (t) => {
  const directory = await temporary(t, "atomic-file-");
  const path = join(directory, "checkpoint.json");
  await writeFile(path, "old\n");

  await atomicReplaceFile(path, "new\n");

  assert.equal(await readFile(path, "utf8"), "new\n");
  assert.deepEqual(await readdir(directory), ["checkpoint.json"]);
});

test("a failed atomic replacement removes its temporary file", async (t) => {
  const directory = await temporary(t, "atomic-file-failure-");
  const path = join(directory, "checkpoint.json");

  await assert.rejects(
    atomicReplaceFile(path, undefined as unknown as string),
    { code: "ERR_INVALID_ARG_TYPE" },
  );

  assert.deepEqual(await readdir(directory), []);
});
