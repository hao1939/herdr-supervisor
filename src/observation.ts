import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const resolvedSessions = new Map();

export function defaultCodexSessionsRoot(env = process.env) {
  const codexRoot = env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexRoot, "sessions");
}

async function findSessionFile(directory, suffix) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(suffix)) return join(directory, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findSessionFile(join(directory, entry.name), suffix);
    if (found) return found;
  }
  return undefined;
}

export async function resolveCodexSessionFile(agentSession, sessionsRoot = defaultCodexSessionsRoot()) {
  if (agentSession.kind === "path" && isAbsolute(agentSession.value)) return agentSession.value;
  if (agentSession.kind !== "id") return undefined;
  const key = `${sessionsRoot}\0${agentSession.value}`;
  const cached = resolvedSessions.get(key);
  if (cached) return cached;
  const resolved = await findSessionFile(sessionsRoot, `-${agentSession.value}.jsonl`);
  if (resolved) resolvedSessions.set(key, resolved);
  return resolved;
}

function assistantMessage(record) {
  const payload = record?.type === "response_item" ? record.payload : undefined;
  if (payload?.type !== "message" || payload.role !== "assistant") return undefined;
  const text = payload.content
    ?.filter((item) => item?.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (!text) return undefined;
  return {
    timestamp: record.timestamp,
    phase: payload.phase || "message",
    text,
  };
}

function boundMessages(messages, maxMessages, maxChars) {
  const selected = [];
  let remaining = maxChars;
  for (let index = messages.length - 1; index >= 0 && selected.length < maxMessages && remaining > 0; index -= 1) {
    const message = messages[index];
    const clipped = message.text.length > remaining
      ? `${message.text.slice(0, Math.max(0, remaining - 15))}\n…[truncated]`
      : message.text;
    selected.push({ ...message, text: clipped });
    remaining -= clipped.length;
  }
  return selected.reverse();
}

export async function readCodexMessages(
  path,
  cursor?,
  { maxBytes = 512 * 1024, maxMessages = 12, maxChars = 24_000 } = {},
) {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    const continued = cursor?.kind === "codex-jsonl" && cursor.path === path && cursor.offset <= info.size;
    const desiredStart = continued ? cursor.offset : Math.max(0, info.size - maxBytes);
    const start = Math.max(desiredStart, info.size - maxBytes);
    const length = info.size - start;
    const buffer = Buffer.alloc(length);
    if (length) await file.read(buffer, 0, length, start);
    const finalNewline = buffer.lastIndexOf(0x0a);
    const complete = finalNewline < 0 ? buffer.subarray(0, 0) : buffer.subarray(0, finalNewline + 1);
    let input = complete.toString("utf8");
    const droppedBytes = start > desiredStart;
    if (start > 0 && (!continued || droppedBytes)) {
      const newline = input.indexOf("\n");
      input = newline < 0 ? "" : input.slice(newline + 1);
    }
    const messages = [];
    for (const line of input.split("\n")) {
      if (!line.trim()) continue;
      try {
        const message = assistantMessage(JSON.parse(line));
        if (message) messages.push(message);
      } catch {
        // A concurrently appended final line can be incomplete. The next read sees it again.
      }
    }
    return {
      source: "codex-session",
      messages: boundMessages(messages, maxMessages, maxChars),
      cursor: { kind: "codex-jsonl", path, offset: start + complete.length },
      truncated: droppedBytes || (!continued && start > 0) || messages.length > maxMessages,
    };
  } finally {
    await file.close();
  }
}

export async function observeWorker(binding, herdrClient, options: any = {}) {
  let nativeObservation;
  if (binding.agentSession.agent === "codex") {
    const path = await resolveCodexSessionFile(binding.agentSession, options.codexSessionsRoot);
    if (path) {
      const readOptions = binding.observationCursor
        ? options
        : { ...options, maxMessages: options.maxMessages ?? 1 };
      nativeObservation = await readCodexMessages(path, binding.observationCursor, readOptions);
      if (nativeObservation.messages.length) return nativeObservation;
      if (!options.fallbackWhenEmpty) return nativeObservation;
    }
  }
  const result = await herdrClient.readAgent(binding.paneId, options.terminalLines || 40);
  return {
    source: "terminal-fallback",
    messages: [{ phase: "terminal", text: result.read.text }],
    cursor: nativeObservation?.cursor || binding.observationCursor,
    truncated: result.read.truncated,
  };
}

export function formatObservation(observation) {
  if (!observation.messages.length) {
    return `Evidence source: ${observation.source}\nNo new assistant messages since the previous review.`;
  }
  const messages = observation.messages.map((message) => {
    const heading = message.phase === "final_answer" ? "Final response" : "Worker update";
    return `${heading}${message.timestamp ? ` · ${message.timestamp}` : ""}\n${message.text}`;
  });
  const note = observation.truncated ? "\n\nOlder observation data was omitted to keep this review bounded." : "";
  return `Evidence source: ${observation.source}\n\n${messages.join("\n\n")}\n${note}`.trimEnd();
}
