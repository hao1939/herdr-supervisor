import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export async function atomicReplaceFile(path: string, content: string | Uint8Array) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(content);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      // The file sync protects its contents. Syncing the containing directory
      // protects the rename that makes those contents current after a crash.
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
