import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { creatorUploadResponse } from "./uploads";
import type { PrivateObjectStore } from "@/storage/object-store";

const store = {} as PrivateObjectStore;
const sql = {} as Sql;

function request(fields: Record<string, string>, file?: { name: string; bytes: Uint8Array }) {
  const form = new FormData();
  if (file) form.set("source", new File([file.bytes as unknown as BlobPart], file.name));
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return new Request("http://127.0.0.1/api/creator/sources", { method: "POST", body: form });
}

describe("private upload requests", () => {
  it("rejects an anonymous upload before using the database", async () => {
    const result = await creatorUploadResponse({
      session: null,
      sql,
      store,
      request: request({ rightsDeclaration: "permission-asserted", idempotencyKey: randomUUID() }, { name: "lesson.md", bytes: Buffer.from("# Rivers\n") }),
    });
    expect(result).toEqual({ status: 401, body: { error: "unauthenticated" } });
  });

  it("rejects a client identity, a cleared declaration, and an unsafe file", async () => {
    const session = { userId: "11111111-1111-4111-8111-111111111111", identity: { userId: "11111111-1111-4111-8111-111111111111" } as never };
    const key = randomUUID();
    const supplied = await creatorUploadResponse({
      session,
      sql,
      store,
      request: request({
        rightsDeclaration: "permission-asserted",
        idempotencyKey: key,
        userId: "22222222-2222-4222-8222-222222222222",
      }, { name: "lesson.md", bytes: Buffer.from("# Rivers\n") }),
    });
    expect(supplied).toMatchObject({ status: 400, body: { error: "invalid-source" } });
    const cleared = await creatorUploadResponse({
      session,
      sql,
      store,
      request: request({ rightsDeclaration: "cleared", idempotencyKey: key }, { name: "lesson.md", bytes: Buffer.from("# Rivers\n") }),
    });
    expect(cleared).toMatchObject({ status: 400, body: { error: "invalid-source" } });
    const executable = await creatorUploadResponse({
      session,
      sql,
      store,
      request: request({ rightsDeclaration: "permission-asserted", idempotencyKey: key }, { name: "lesson.exe", bytes: Buffer.from("text") }),
    });
    expect(executable).toMatchObject({ status: 400, body: { error: "unsupported-type" } });
    const disguised = await creatorUploadResponse({
      session,
      sql,
      store,
      request: request({ rightsDeclaration: "permission-asserted", idempotencyKey: key }, { name: "lesson.txt", bytes: Buffer.from([0x4d, 0x5a, 0x00, 0x00]) }),
    });
    expect(disguised).toMatchObject({ status: 400, body: { error: "invalid-structure" } });
    const empty = await creatorUploadResponse({
      session,
      sql,
      store,
      request: request({ rightsDeclaration: "permission-asserted", idempotencyKey: key }, { name: "lesson.txt", bytes: Buffer.alloc(0) }),
    });
    expect(empty).toMatchObject({ status: 400, body: { error: "empty-file" } });
    const oversized = await creatorUploadResponse({
      session,
      sql,
      store,
      limits: { maxBytes: 8 },
      request: request({ rightsDeclaration: "permission-asserted", idempotencyKey: key }, { name: "lesson.txt", bytes: Buffer.from("0123456789") }),
    });
    expect(oversized).toMatchObject({ status: 413, body: { error: "oversized" } });
  });
});
