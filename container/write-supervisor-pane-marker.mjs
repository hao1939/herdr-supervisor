#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicReplaceFile } from "../src/atomic-file.ts";

const [path, paneId] = process.argv.slice(2);
if (!path || !paneId || paneId.includes("\n")) {
  console.error("usage: write-supervisor-pane-marker <path> <pane-id>");
  process.exit(2);
}

await mkdir(dirname(path), { recursive: true, mode: 0o700 });
await atomicReplaceFile(path, `${paneId}\n`);
