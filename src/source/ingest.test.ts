import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SYNTHETIC_WORKSPACE_ID } from "@/contracts/common";
import { docx, textPdf, zipStored } from "./fixtures";
import { SourceError } from "./errors";
import { ingestDocument, readCanonicalText } from "./ingest";
import { enqueueSourceJob, processSourceJobs } from "./jobs";
import { assertKnowledge, buildKnowledge } from "./knowledge";
import { sourceLimits } from "./limits";
import { issueMembershipForIsolatedTests, type VerifiedMembership } from "./membership";
import { createSourceStore, type SourceStore } from "./store";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const roots: string[] = [];

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "adeena-source-"));
  roots.push(root);
  return createSourceStore(root);
}

function member(workspaceId = WORKSPACE_A) {
  return issueMembershipForIsolatedTests(workspaceId, ACTOR);
}

async function ingest(store: SourceStore, filename: string, bytes: Uint8Array, limits?: Parameters<typeof sourceLimits>[0]) {
  return ingestDocument({ membership: member(), filename, bytes, store, limits });
}

afterEach(() => {
  roots.length = 0;
});

describe("source ingestion", () => {
  it("extracts a text file into hashed spans", async () => {
    const store = await workspace();
    const bytes = Buffer.from("Rivers carry water.\n\nThey reach the sea.");
    const result = await ingest(store, "C:\\secret\\lesson.txt", bytes);
    expect(result.version.filename).toBe("lesson.txt");
    expect(result.version.version).toBe(1);
    expect(result.version.immutable).toBe(true);
    expect(result.version.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.version.educationalValidation).toBe("none");
    expect(result.extraction.extractor).toEqual({ name: "adeena.source-extract", version: "1" });
    expect(result.extraction.status).toBe("complete");
    expect(result.cost.aiGenerationAuthorized).toBe(false);
    expect(result.cost.uploadedBytes).toBe(bytes.byteLength);
    const text = await readCanonicalText({ membership: member(), contentHash: result.version.contentHash, store });
    expect(text).toBe("Rivers carry water.\n\nThey reach the sea.");
    const block = result.nodes.find((node) => node.kind === "block");
    const span = result.spans.find((item) => item.id === block?.spanId);
    expect(text.slice(span?.start, span?.end)).toBe("Rivers carry water.");
  });

  it("keeps reliable Markdown headings and reports ambiguous plain-text headings", async () => {
    const store = await workspace();
    const markdown = await ingest(store, "chapter.md", Buffer.from("# Rivers\n\nWater moves downhill.\n\n## Mouth\n\nThe river meets the sea."));
    expect(markdown.nodes.map((node) => node.kind)).toEqual(["document", "chapter", "block", "section", "block"]);
    expect(markdown.nodes[1]?.headingCertainty).toBe("reliable");
    const plain = await ingest(store, "notes.txt", Buffer.from("Chapter 1\n\nA short note."));
    expect(plain.extraction.status).toBe("partial");
    expect(plain.extraction.issues).toEqual([{ code: "ambiguous-structure", page: null }]);
    expect(plain.nodes.some((node) => node.kind === "chapter")).toBe(false);
  });

  it("extracts DOCX paragraphs and heading styles", async () => {
    const store = await workspace();
    const result = await ingest(
      store,
      "lesson.docx",
      docx([
        { text: "Rivers", style: "Heading1" },
        { text: "Water moves downhill." },
      ]),
    );
    expect(result.nodes.map((node) => [node.kind, node.title])).toEqual([
      ["document", null],
      ["chapter", "Rivers"],
      ["block", null],
    ]);
    expect(result.extraction.status).toBe("complete");
  });

  it("extracts a text-layer PDF with page references and refuses pages past the ceiling", async () => {
    const store = await workspace();
    const result = await ingest(store, "lesson.pdf", textPdf(["Hello from Adeena", ""]));
    expect(result.extraction.status).toBe("partial");
    expect(result.extraction.pageCount).toBe(2);
    expect(result.spans.find((span) => span.page === 1)).toBeTruthy();
    expect(result.extraction.issues).toEqual([{ code: "unreadable-page", page: 2 }]);
    const text = await readCanonicalText({ membership: member(), contentHash: result.version.contentHash, store });
    expect(text).toContain("Hello from Adeena");
    await expect(ingest(store, "long.pdf", textPdf(["One", "Two", "Three"]), { maxPdfPages: 2 })).rejects.toMatchObject({
      code: "page-limit",
    });
  });

  it("rejects empty, unsupported, disguised, malformed, and oversized files", async () => {
    const store = await workspace();
    await expect(ingest(store, "empty.txt", Buffer.alloc(0))).rejects.toMatchObject({ code: "empty-file" });
    await expect(ingest(store, "old.doc", Buffer.from("text"))).rejects.toMatchObject({ code: "unsupported-type" });
    await expect(ingest(store, "lesson.pdf", Buffer.from([0x4d, 0x5a, 0x00, 0x00]))).rejects.toMatchObject({
      code: "invalid-structure",
    });
    await expect(ingest(store, "broken.docx", Buffer.from("PK\u0003\u0004not-a-zip"))).rejects.toMatchObject({
      code: "malformed-docx",
    });
    await expect(ingest(store, "big.txt", Buffer.from("abcdef"), { maxBytes: 4 })).rejects.toMatchObject({
      code: "oversized",
    });
  });

  it("rejects zip decompression abuse, macros, encrypted PDFs, and image-only PDFs", async () => {
    const store = await workspace();
    const many = Array.from({ length: 12 }, (_, index) => ({ name: `word/part-${index}.xml`, data: Buffer.from("x") }));
    await expect(ingest(store, "wide.docx", zipStored(many), { maxZipEntries: 4 })).rejects.toMatchObject({ code: "zip-limit" });
    const zeros = Buffer.alloc(8_000);
    await expect(
      ingest(store, "ratio.docx", zipStored([{ name: "word/document.xml", data: zeros, method: 8 }]), {
        maxCompressionRatio: 5,
        maxUncompressedBytes: 20_000,
      }),
    ).rejects.toMatchObject({ code: "zip-limit" });
    await expect(
      ingest(store, "macro.docx", docx([{ text: "Hello" }], [{ name: "word/vbaProject.bin", data: Buffer.from("macro") }])),
    ).rejects.toMatchObject({ code: "macro" });
    const secret = "SECRET-PHRASE";
    const encrypted = Buffer.concat([textPdf([secret]), Buffer.from("\n% /Encrypt\n")]);
    await expect(ingest(store, "locked.pdf", encrypted)).rejects.toMatchObject({ code: "encrypted-pdf" });
    const hash = createHash("sha256").update(encrypted).digest("hex");
    const extraction = JSON.stringify(await store.readJson(WORKSPACE_A, hash, "extraction.json"));
    expect(extraction).not.toContain(secret);
    expect(new SourceError("encrypted-pdf").message).not.toContain(secret);
    await expect(ingest(store, "scan.pdf", textPdf([""]))).rejects.toMatchObject({ code: "image-only-pdf" });
  });

  it("replays the same bytes without a new version and keeps the record across a new store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adeena-source-"));
    roots.push(root);
    const first = await ingest(createSourceStore(root), "lesson.txt", Buffer.from("A durable note."));
    const second = await ingest(createSourceStore(root), "copied.txt", Buffer.from("A durable note."));
    expect(second.replayed).toBe(true);
    expect(second.version).toEqual(first.version);
    const original = await readFile(path.join(root, WORKSPACE_A, first.version.contentHash, "original.bin"));
    await writeFile(path.join(root, WORKSPACE_A, first.version.contentHash, "original.bin"), Buffer.from("tampered"));
    await expect(createSourceStore(root).readBytes(WORKSPACE_A, first.version.contentHash)).rejects.toMatchObject({
      code: "integrity-mismatch",
    });
    expect(original.toString()).toBe("A durable note.");
  });

  it("denies missing membership and another workspace", async () => {
    const store = await workspace();
    const bytes = Buffer.from("Private lesson.");
    const result = await ingest(store, "private.txt", bytes);
    await expect(
      ingestDocument({
        membership: {} as VerifiedMembership,
        filename: "private.txt",
        bytes,
        store,
      }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(() => issueMembershipForIsolatedTests(SYNTHETIC_WORKSPACE_ID, ACTOR)).toThrow(SourceError);
    await expect(
      readCanonicalText({
        membership: member(WORKSPACE_B),
        contentHash: result.version.contentHash,
        store,
      }),
    ).rejects.toMatchObject({ code: "cross-workspace" });
    await expect(store.readBytes(`${WORKSPACE_A}/../../${WORKSPACE_B}`, result.version.contentHash)).rejects.toMatchObject({
      code: "invalid-path",
    });
    expect(() => createSourceStore(path.join(tmpdir(), "public", "uploads"))).toThrow(SourceError);
  });

  it("queues work, retries a transient failure, and recovers a processing job after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adeena-source-"));
    roots.push(root);
    const store = createSourceStore(root);
    const retry = await enqueueSourceJob({
      membership: member(),
      filename: "retry.txt",
      bytes: Buffer.from("Retry this note."),
      store,
      maxAttempts: 2,
    });
    const retried = await processSourceJobs(store, member(), { transientFailures: 1 });
    expect(retried.find((job) => job.id === retry.id)).toMatchObject({ state: "complete", attempts: 2, errorCode: null });
    const exhausted = await enqueueSourceJob({
      membership: member(),
      filename: "stop.txt",
      bytes: Buffer.from("Stop after the limit."),
      store,
      maxAttempts: 2,
    });
    const stopped = await processSourceJobs(store, member(), { transientFailures: 5 });
    expect(stopped.find((job) => job.id === exhausted.id)).toMatchObject({
      state: "failed",
      attempts: 2,
      errorCode: "transient",
      permanent: true,
    });

    const restartRoot = await mkdtemp(path.join(tmpdir(), "adeena-source-"));
    roots.push(restartRoot);
    const queued = await enqueueSourceJob({
      membership: member(),
      filename: "restart.txt",
      bytes: Buffer.from("This survives a restart."),
      store: createSourceStore(restartRoot),
    });
    const crashed = await processSourceJobs(createSourceStore(restartRoot), member(), { crashAfterMark: true });
    expect(crashed.find((job) => job.id === queued.id)?.state).toBe("processing");
    const recovered = await processSourceJobs(createSourceStore(restartRoot), member());
    expect(recovered.find((job) => job.id === queued.id)?.state).toBe("complete");
    expect(await readCanonicalText({
      membership: member(),
      contentHash: queued.contentHash,
      store: createSourceStore(restartRoot),
    })).toBe("This survives a restart.");
  });

  it("marks an ambiguous document partial without inventing chapters", async () => {
    const store = await workspace();
    const job = await enqueueSourceJob({
      membership: member(),
      filename: "notes.txt",
      bytes: Buffer.from("Chapter 1\n\nA short note."),
      store,
    });
    const jobs = await processSourceJobs(store, member());
    expect(jobs.find((item) => item.id === job.id)?.state).toBe("partial");
  });

  it("rejects a parent cycle and a span from another document", () => {
    const built = buildKnowledge({
      documentVersionId: randomUUID(),
      workspaceId: WORKSPACE_A,
      extracted: [{ kind: "block", text: "One paragraph.", page: null, title: null, headingCertainty: "none" }],
    });
    const cycled = structuredClone(built.nodes);
    const child = cycled[1];
    if (!child) throw new Error("missing node");
    child.parentId = child.id;
    expect(() => assertKnowledge({ collection: built.collection, nodes: cycled, spans: built.spans, canonicalText: built.canonical.text })).toThrow(SourceError);
    const crossed = structuredClone(built.spans);
    const span = crossed[1];
    if (!span) throw new Error("missing span");
    span.documentVersionId = randomUUID();
    expect(() => assertKnowledge({ collection: built.collection, nodes: built.nodes, spans: crossed, canonicalText: built.canonical.text })).toThrow(SourceError);
  });

  it("measures small and larger extraction", async () => {
    const store = await workspace();
    const smallStarted = performance.now();
    const smallBefore = process.memoryUsage().heapUsed;
    const small = await ingest(store, "small.md", Buffer.from("# Rivers\n\nWater moves downhill."));
    const smallDuration = performance.now() - smallStarted;
    const smallHeap = process.memoryUsage().heapUsed - smallBefore;
    const largeText = Array.from({ length: 400 }, (_, index) => `## Section ${index}\n\nA paragraph about water ${index}.`).join("\n\n");
    const largeStarted = performance.now();
    const largeBefore = process.memoryUsage().heapUsed;
    const large = await ingest(store, "manual.md", Buffer.from(largeText));
    const largeDuration = performance.now() - largeStarted;
    const largeHeap = process.memoryUsage().heapUsed - largeBefore;
    const pdfStarted = performance.now();
    const pdfBefore = process.memoryUsage().heapUsed;
    const pdf = await ingest(store, "chapter.pdf", textPdf(Array.from({ length: 20 }, (_, index) => `Page ${index} mentions water.`)));
    const pdfDuration = performance.now() - pdfStarted;
    const pdfHeap = process.memoryUsage().heapUsed - pdfBefore;
    console.info(JSON.stringify({
      smallBytes: small.cost.uploadedBytes,
      smallDurationMs: Math.round(smallDuration),
      smallHeapBytes: smallHeap,
      largeBytes: large.cost.uploadedBytes,
      largeDurationMs: Math.round(largeDuration),
      largeHeapBytes: largeHeap,
      largeNodes: large.nodes.length,
      pdfBytes: pdf.cost.uploadedBytes,
      pdfPages: pdf.extraction.pageCount,
      pdfDurationMs: Math.round(pdfDuration),
      pdfHeapBytes: pdfHeap,
    }));
    expect(small.cost.durationMs).toBeGreaterThanOrEqual(0);
    expect(large.extraction.status).toBe("complete");
    expect(largeDuration).toBeLessThan(2_000);
  });
});
