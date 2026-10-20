import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Sha256, Uuid } from "@/contracts/common";
import { SourceError } from "./errors";

const HASH = /^[a-f0-9]{64}$/;

export type SourceStore = {
  readonly root: string;
  putBytes(workspaceId: string, contentHash: string, bytes: Uint8Array): Promise<"created" | "exists">;
  readBytes(workspaceId: string, contentHash: string): Promise<Uint8Array | null>;
  writeJson(workspaceId: string, contentHash: string, name: string, value: unknown): Promise<void>;
  readJson(workspaceId: string, contentHash: string, name: string): Promise<unknown | null>;
  writeText(workspaceId: string, contentHash: string, name: string, value: string): Promise<void>;
  readText(workspaceId: string, contentHash: string, name: string): Promise<string | null>;
  writeJob(workspaceId: string, jobId: string, value: unknown): Promise<void>;
  readJob(workspaceId: string, jobId: string): Promise<unknown | null>;
  listJobs(workspaceId: string): Promise<unknown[]>;
};

function checkedId(value: string) {
  const parsed = Uuid.safeParse(value);
  if (!parsed.success) throw new SourceError("invalid-path");
  return parsed.data;
}

function checkedHash(value: string) {
  if (!HASH.test(value) || !Sha256.safeParse(value).success) throw new SourceError("invalid-path");
  return value;
}

function inside(root: string, target: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new SourceError("invalid-path");
  return resolved;
}

async function writeAtomic(file: string, bytes: Uint8Array) {
  const temporary = `${file}.${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

export function createSourceStore(root: string): SourceStore {
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot.split(path.sep).includes("public")) throw new SourceError("invalid-path");

  function slot(workspaceId: string, contentHash: string) {
    return inside(resolvedRoot, path.join(resolvedRoot, checkedId(workspaceId), checkedHash(contentHash)));
  }

  return {
    root: resolvedRoot,
    async putBytes(workspaceId, contentHash, bytes) {
      const dir = slot(workspaceId, contentHash);
      await mkdir(dir, { recursive: true });
      const file = inside(dir, path.join(dir, "original.bin"));
      try {
        await writeFile(file, bytes, { flag: "wx" });
        return "created";
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        const stored = await readFile(file);
        const actual = createHash("sha256").update(stored).digest("hex");
        if (actual !== contentHash) throw new SourceError("integrity-mismatch");
        return "exists";
      }
    },
    async readBytes(workspaceId, contentHash) {
      const file = inside(slot(workspaceId, contentHash), path.join(slot(workspaceId, contentHash), "original.bin"));
      try {
        const stored = await readFile(file);
        const actual = createHash("sha256").update(stored).digest("hex");
        if (actual !== contentHash) throw new SourceError("integrity-mismatch");
        return stored;
      } catch (error) {
        if (error instanceof SourceError) throw error;
        return null;
      }
    },
    async writeJson(workspaceId, contentHash, name, value) {
      if (!/^[a-z0-9-]+\.json$/.test(name)) throw new SourceError("invalid-path");
      const dir = slot(workspaceId, contentHash);
      await mkdir(dir, { recursive: true });
      await writeAtomic(inside(dir, path.join(dir, name)), Buffer.from(JSON.stringify(value)));
    },
    async readJson(workspaceId, contentHash, name) {
      if (!/^[a-z0-9-]+\.json$/.test(name)) throw new SourceError("invalid-path");
      const dir = slot(workspaceId, contentHash);
      try {
        return JSON.parse(await readFile(inside(dir, path.join(dir, name)), "utf8")) as unknown;
      } catch {
        return null;
      }
    },
    async writeText(workspaceId, contentHash, name, value) {
      if (!/^[a-z0-9-]+\.txt$/.test(name)) throw new SourceError("invalid-path");
      const dir = slot(workspaceId, contentHash);
      await mkdir(dir, { recursive: true });
      await writeAtomic(inside(dir, path.join(dir, name)), Buffer.from(value, "utf8"));
    },
    async readText(workspaceId, contentHash, name) {
      if (!/^[a-z0-9-]+\.txt$/.test(name)) throw new SourceError("invalid-path");
      const dir = slot(workspaceId, contentHash);
      try {
        return await readFile(inside(dir, path.join(dir, name)), "utf8");
      } catch {
        return null;
      }
    },
    async writeJob(workspaceId, jobId, value) {
      const dir = inside(resolvedRoot, path.join(resolvedRoot, checkedId(workspaceId), "jobs"));
      await mkdir(dir, { recursive: true });
      await writeAtomic(inside(dir, path.join(dir, `${checkedId(jobId)}.json`)), Buffer.from(JSON.stringify(value)));
    },
    async readJob(workspaceId, jobId) {
      const file = inside(
        resolvedRoot,
        path.join(resolvedRoot, checkedId(workspaceId), "jobs", `${checkedId(jobId)}.json`),
      );
      try {
        return JSON.parse(await readFile(file, "utf8")) as unknown;
      } catch {
        return null;
      }
    },
    async listJobs(workspaceId) {
      const dir = inside(resolvedRoot, path.join(resolvedRoot, checkedId(workspaceId), "jobs"));
      let names: string[] = [];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      const jobs: unknown[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const parsed = JSON.parse(await readFile(inside(dir, path.join(dir, name)), "utf8")) as unknown;
        jobs.push(parsed);
      }
      return jobs;
    },
  };
}
