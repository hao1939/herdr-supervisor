import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatObservation,
  observeWorker,
  readCodexMessages,
  resolveCodexSessionFile,
} from "../src/observation.js";

function record(role, text, phase = "commentary", timestamp = "2026-08-28T01:00:00Z") {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "message", role, phase, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] },
  });
}

test("Codex adapter resolves an exact native session and returns only assistant messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-sessions-"));
  const directory = join(root, "2026", "08", "28");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "rollout-2026-08-28T01-00-00-session-1.jsonl");
  await writeFile(path, [
    record("user", "secret request"),
    record("assistant", "I am testing the fix."),
    record("assistant", "The focused test passes.", "final_answer"),
    "",
  ].join("\n"));

  assert.equal(
    await resolveCodexSessionFile({ kind: "id", value: "session-1" }, root),
    path,
  );
  const observation = await readCodexMessages(path);
  assert.deepEqual(observation.messages.map((message) => message.text), [
    "I am testing the fix.",
    "The focused test passes.",
  ]);
  assert.doesNotMatch(formatObservation(observation), /secret request/);
});

test("cursor returns only newly appended native messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-sessions-"));
  const path = join(root, "rollout-session-2.jsonl");
  await writeFile(path, `${record("assistant", "first")}\n`);
  const first = await readCodexMessages(path);
  await writeFile(path, `${record("assistant", "first")}\n${record("assistant", "second", "final_answer")}\n`);
  const second = await readCodexMessages(path, first.cursor);
  assert.deepEqual(second.messages.map((message) => message.text), ["second"]);
});

test("a new goal binding starts from only the worker's latest assistant message", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-sessions-"));
  const path = join(root, "rollout-new-goal.jsonl");
  await writeFile(path, [
    record("assistant", "Old goal completed.", "final_answer"),
    record("assistant", "Which color should I use for the new goal?", "final_answer"),
    "",
  ].join("\n"));
  const binding = {
    paneId: "w1:p2",
    agentSession: { agent: "codex", kind: "path", value: path },
  };
  const observation = await observeWorker(binding, { readAgent() {} });
  assert.deepEqual(observation.messages.map((message) => message.text), [
    "Which color should I use for the new goal?",
  ]);
  assert.equal(observation.truncated, true);
});

test("cursor retains an incomplete final JSONL record for the next observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-sessions-"));
  const path = join(root, "rollout-session-partial.jsonl");
  const complete = `${record("assistant", "first")}\n`;
  const second = record("assistant", "second", "final_answer");
  await writeFile(path, `${complete}${second.slice(0, -8)}`);

  const first = await readCodexMessages(path);
  assert.deepEqual(first.messages.map((message) => message.text), ["first"]);
  assert.equal(first.cursor.offset, Buffer.byteLength(complete));

  await appendFile(path, `${second.slice(-8)}\n`);
  const resumed = await readCodexMessages(path, first.cursor);
  assert.deepEqual(resumed.messages.map((message) => message.text), ["second"]);
});

test("a missing native session can be discovered after it is created", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-sessions-"));
  const session = { kind: "id", value: "late-session" };
  assert.equal(await resolveCodexSessionFile(session, root), undefined);

  const path = join(root, "rollout-late-session.jsonl");
  await writeFile(path, "");
  assert.equal(await resolveCodexSessionFile(session, root), path);
});

test("terminal fallback preserves progress through an empty native observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-sessions-"));
  const path = join(root, "rollout-codex-fallback.jsonl");
  const nonAssistant = `${record("user", "ordinary worker input")}\n`;
  await writeFile(path, nonAssistant);
  const binding = {
    paneId: "w1:p2",
    agentSession: { agent: "codex", kind: "path", value: path },
  };
  const client = {
    async readAgent() {
      return { read: { text: "worker is blocked", truncated: false } };
    },
  };

  const observation = await observeWorker(binding, client, { fallbackWhenEmpty: true });
  assert.equal(observation.source, "terminal-fallback");
  assert.equal(observation.cursor.offset, Buffer.byteLength(nonAssistant));
});

test("non-Codex workers use a bounded terminal fallback without worker integration", async () => {
  const binding = {
    paneId: "w1:p2",
    agentSession: { agent: "claude", kind: "id", value: "session" },
  };
  const client = {
    async readAgent(paneId, lines) {
      assert.equal(paneId, "w1:p2");
      assert.equal(lines, 40);
      return { read: { text: "native adapter not available", truncated: false } };
    },
  };
  const observation = await observeWorker(binding, client);
  assert.equal(observation.source, "terminal-fallback");
  assert.equal(observation.messages[0].text, "native adapter not available");
});
