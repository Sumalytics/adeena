import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SourceError } from "@/source/errors";
import { createFilesystemObjectStore, originalLocator } from "./filesystem";
import { reconcileOrphans } from "./reconcile";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const keptBytes = Buffer.from("kept lesson");
const hash = createHash("sha256").update(keptBytes).digest("hex");

describe("private filesystem storage", () => {
  it("rejects a public directory and an unavailable root", async () => {
    expect(() => createFilesystemObjectStore(path.join(tmpdir(), "public", "uploads"))).toThrow(SourceError);
    const root = await mkdtemp(path.join(tmpdir(), "adeena-storage-"));
    const blocked = path.join(root, "not-a-directory");
    await writeFile(blocked, "x");
    const store = createFilesystemObjectStore(blocked);
    await expect(store.putOriginal(workspaceId, hash, Buffer.from("lesson"))).rejects.toThrow("Private storage is unavailable.");
  });

  it("retires orphan objects and keeps referenced ones", async () => {
    const store = createFilesystemObjectStore(await mkdtemp(path.join(tmpdir(), "adeena-storage-")));
    const kept = await store.putOriginal(workspaceId, hash, keptBytes);
    const orphanBytes = Buffer.from("orphan lesson");
    const orphanHash = createHash("sha256").update(orphanBytes).digest("hex");
    const orphan = await store.putOriginal(workspaceId, orphanHash, orphanBytes);
    const retired = await reconcileOrphans(store, workspaceId, [kept.locator]);
    expect(retired).toEqual([orphan.locator]);
    expect(await store.verifyOriginal(workspaceId, hash)).toBe(true);
    expect(kept.locator).toBe(originalLocator(workspaceId, hash));
    await expect(store.readOriginal(workspaceId, orphanHash)).rejects.toThrow(SourceError);
  });
});
