import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { SourceError } from "@/source/errors";
import { createSourceStore } from "@/source/store";
import type { PrivateObjectStore } from "./object-store";

const LOCATOR = /^private:\/\/([0-9a-f-]{36})\/([a-f0-9]{64})\/(original\.bin|canonical\.txt)$/;

export function originalLocator(workspaceId: string, contentHash: string) {
  return `private://${workspaceId}/${contentHash}/original.bin`;
}

export function canonicalLocator(workspaceId: string, contentHash: string) {
  return `private://${workspaceId}/${contentHash}/canonical.txt`;
}

function parts(locator: string) {
  const match = LOCATOR.exec(locator);
  if (!match?.[1] || !match[2] || !match[3]) throw new SourceError("invalid-path");
  return { workspaceId: match[1], contentHash: match[2], name: match[3] };
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new Error("Private storage is unavailable.");
  }
}

export function createFilesystemObjectStore(root: string): PrivateObjectStore {
  const files = createSourceStore(root);
  return {
    async putOriginal(workspaceId, contentHash, bytes) {
      return guard(async () => {
        const created = await files.putBytes(workspaceId, contentHash, bytes);
        return { locator: originalLocator(workspaceId, contentHash), created: created === "created" };
      });
    },
    async readOriginal(workspaceId, contentHash) {
      const stored = await files.readBytes(workspaceId, contentHash);
      if (!stored) throw new SourceError("cross-workspace");
      return stored;
    },
    async putCanonical(workspaceId, contentHash, text) {
      await files.writeText(workspaceId, contentHash, "canonical.txt", text);
      return { locator: canonicalLocator(workspaceId, contentHash), created: true };
    },
    async readCanonical(workspaceId, contentHash) {
      const text = await files.readText(workspaceId, contentHash, "canonical.txt");
      if (text === null) throw new SourceError("cross-workspace");
      return text;
    },
    async verifyOriginal(workspaceId, contentHash) {
      const stored = await files.readBytes(workspaceId, contentHash);
      if (!stored) return false;
      return createHash("sha256").update(stored).digest("hex") === contentHash;
    },
    async retire(locator) {
      const parsed = parts(locator);
      const folder = path.join(files.root, parsed.workspaceId, parsed.contentHash);
      await rm(path.join(folder, parsed.name), { force: true });
    },
    async listLocators(workspaceId) {
      if (!/^[0-9a-f-]{36}$/.test(workspaceId)) throw new SourceError("invalid-path");
      const folder = path.resolve(files.root, workspaceId);
      if (!folder.startsWith(files.root + path.sep)) throw new SourceError("invalid-path");
      let hashes: string[] = [];
      try {
        hashes = await readdir(folder);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw new SourceError("invalid-path");
      }
      const locators: string[] = [];
      for (const hash of hashes) {
        if (!/^[a-f0-9]{64}$/.test(hash)) continue;
        const slot = path.join(folder, hash);
        for (const name of ["original.bin", "canonical.txt"] as const) {
          try {
            const info = await stat(path.join(slot, name));
            if (info.isFile()) locators.push(`private://${workspaceId}/${hash}/${name}`);
          } catch {
            // A missing half of a slot is not a locator.
          }
        }
      }
      return locators;
    },
  };
}
