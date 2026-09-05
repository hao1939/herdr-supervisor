#!/usr/bin/env node
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "@earendil-works/pi-coding-agent";

const MAX_HEADER_BYTES = 64 * 1024;

function sessionFileId(path) {
  const file = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_HEADER_BYTES + 1);
    const bytes = readSync(file, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytes).indexOf(10);
    if (newline < 0 && bytes > MAX_HEADER_BYTES) return undefined;
    const header = JSON.parse(buffer.subarray(0, newline < 0 ? bytes : newline).toString("utf8"));
    return header?.type === "session" && typeof header.id === "string" ? header.id : undefined;
  } finally {
    closeSync(file);
  }
}

const [markerFile, paneId, cwd, supervisorExtension, ...args] = process.argv.slice(2);
if (!markerFile || !paneId || !cwd || !supervisorExtension) process.exit(2);

const parsed = parseArgs(args);
const valid = !parsed.diagnostics.some(({ type }) => type === "error");
const nonInteractiveMetadata = parsed.help
  || parsed.version
  || parsed.export
  || parsed.listModels !== undefined;

let restore = false;
if (valid
  && !nonInteractiveMetadata
  && !parsed.noSession
  && !parsed.extensions?.includes(supervisorExtension)
  && !parsed.fork
  && !parsed.sessionId
  && parsed.session) {
  try {
    const [markerPane, markerSessionFile, markerSessionId] = readFileSync(markerFile, "utf8").split(/\r?\n/);
    const pathSession = parsed.session.includes("/") || parsed.session.includes("\\") || parsed.session.endsWith(".jsonl");
    if (markerPane === paneId
      && markerSessionFile
      && markerSessionId
      && pathSession
      && resolve(cwd, parsed.session) === markerSessionFile
      && sessionFileId(markerSessionFile) === markerSessionId) {
      restore = true;
    }
  } catch {
    // A missing or concurrently replaced marker fails closed. The next native
    // restart can retry from the durable session marker.
  }
}

process.stdout.write(restore ? "1\n" : "0\n");
