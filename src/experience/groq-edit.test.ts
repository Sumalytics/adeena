import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileExperiencePlan } from "./compile";
import { applyModelOutput, dialogueEditContext, groqEditKind, prepareDialogueTarget, screenEditInstruction } from "./edit";
import { groqTransportSchema, mapGroqTransport, readGroqAssistantPayload } from "./groq-edit";
import { GROQ_GPT_OSS_120B_MODEL, GROQ_RESPONSES_URL, requestPaidEdit } from "./provider";
import { simulateExperience } from "./simulate";

const lesson = "Learners compare two careful choices and explain the result using only this passage. ".repeat(4);
const instruction = "Rewrite the opening dialogue in clearer, more engaging everyday English. Keep the learning objective, facts, choices and consequences unchanged.";

function draft() {
  const compiled = compileExperiencePlan({
    documentVersionId: randomUUID(),
    topicTitle: "Clouds",
    audienceLabel: "Primary learners",
    ageBand: "8-10",
    spans: [{ id: randomUUID(), excerpt: lesson }],
    experienceId: randomUUID(),
    versionId: randomUUID(),
  });
  if (!compiled.ok) throw new Error("fixture");
  return compiled.manifest;
}

function assistant(payload: unknown, extras: Record<string, unknown> = {}) {
  return {
    id: "resp_unit",
    status: "completed",
    output: [
      { type: "reasoning", content: [{ type: "output_text", text: "{\"operations\":[{\"op\":\"set-presentation\",\"sceneId\":\"opening\",\"title\":\"Wrong\"}]}" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(payload) }] },
    ],
    usage: { input_tokens: 20, output_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 4 } },
    ...extras,
  };
}

const freeEnv = {
  ADEENA_EXPERIENCE_PROVIDER: "configured-provider",
  ADEENA_AI_EXECUTION_MODE: "free-development",
  ADEENA_RUNTIME: "local-development",
  ADEENA_GROQ_PLAN: "free",
  ADEENA_GROQ_API_KEY: "gsk-test",
  ADEENA_AI_MODEL: GROQ_GPT_OSS_120B_MODEL,
  ADEENA_AI_API_URL: GROQ_RESPONSES_URL,
  NODE_ENV: "test",
};

describe("Groq structured edit transport", () => {
  it("reads the assistant object and ignores a reasoning object", () => {
    const payload = { sceneId: "opening", text: "Plain words." };
    const read = readGroqAssistantPayload(assistant(payload));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const mapped = mapGroqTransport(read.payload);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.edit.operations).toEqual([{ op: "rewrite-text", sceneId: "opening", text: "Plain words." }]);
  });

  it("rejects missing assistant JSON, fences, incomplete output, and a refusal", () => {
    const reasoningOnly = readGroqAssistantPayload({
      status: "completed",
      output: [{ type: "reasoning", content: [{ type: "output_text", text: "{\"operations\":[]}" }] }],
    });
    expect(reasoningOnly).toMatchObject({ ok: false, diagnostic: expect.stringContaining("message:") });
    const fenced = readGroqAssistantPayload({
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "```json\n{\"intent\":\"x\"}\n```" }] }],
    });
    expect(fenced).toMatchObject({ ok: false, diagnostic: expect.stringContaining("output_text") });
    expect(readGroqAssistantPayload({ status: "incomplete", output: [] })).toMatchObject({ ok: false, status: "incomplete" });
    expect(readGroqAssistantPayload({
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
    })).toMatchObject({ ok: false, status: "refusal" });
  });

  it("maps a narrow passage onto the canonical edit and trims it", () => {
    const mapped = mapGroqTransport({ sceneId: "opening", text: "  Plain words.  " });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.edit.operations[0]).toEqual({ op: "rewrite-text", sceneId: "opening", text: "Plain words." });
    expect(mapped.edit.factualChange).toBe(false);
    expect("preserved" in mapped.edit).toBe(false);
    expect("contract" in mapped.edit).toBe(false);
  });

  it("rejects a missing field, a bad scene id, and protected metadata", () => {
    const missing = mapGroqTransport({ sceneId: "opening" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.diagnostic).toContain("text");
    expect(missing.diagnostic).toContain("expected_string");
    const malformed = mapGroqTransport({ sceneId: "Opening", text: "Plain words." });
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.diagnostic).toContain("sceneId");
    expect(malformed.diagnostic).toContain("actual_Opening");
    const metadata = mapGroqTransport({ sceneId: "opening", text: "Plain words.", publicationStatus: "published" });
    expect(metadata.ok).toBe(false);
    if (metadata.ok) return;
    expect(metadata.diagnostic).toContain("unrecognized_keys");
  });

  it("keeps the transport schema closed and free of server-owned plan fields", () => {
    const schema = groqTransportSchema("opening");
    expect(JSON.stringify(schema)).not.toContain("preserved");
    expect(JSON.stringify(schema)).not.toContain("promptVersion");
    expect(JSON.stringify(schema)).not.toContain("EXPERIENCE-");
    expect(JSON.stringify(schema)).not.toContain("rewrite-text");
    assertClosed(schema);
    expect(JSON.stringify(schema)).toContain('"opening"');
  });

  it("saves an immutable proposed revision and leaves the base draft unchanged", () => {
    const manifest = draft();
    const before = structuredClone(manifest);
    const target = prepareDialogueTarget(manifest, "opening");
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const mapped = mapGroqTransport({ sceneId: "opening", text: "The source does not mention this room." }, target.target);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const firstId = randomUUID();
    const first = applyModelOutput(manifest, instruction, mapped.edit, firstId, "opening");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(manifest).toEqual(before);
    expect(first.manifest.versionId).toBe(firstId);
    expect(first.manifest.versionId).not.toBe(before.versionId);
    expect(first.plan.contract).toBe("EXPERIENCE-EDIT-PLAN-v1");
    expect(first.plan.promptVersion).toBe("model-edit@1");
    expect(first.plan.preserved.length).toBeGreaterThan(0);
    expect(first.validation.simulation.ok).toBe(true);
    const replay = applyModelOutput(manifest, instruction, mapped.edit, randomUUID(), "opening");
    expect(replay.ok).toBe(true);
    expect(manifest).toEqual(before);
    if (!replay.ok) return;
    expect(replay.manifest.versionId).not.toBe(first.manifest.versionId);
    const choices = (sceneId: string, source: typeof manifest) => {
      const scene = source.scenes.find((item) => item.id === sceneId);
      return scene && scene.role === "dialogue" ? scene.choices.map((choice) => [choice.id, choice.nextSceneId]) : [];
    };
    expect(choices("opening", first.manifest)).toEqual(choices("opening", before));
    expect(choices("decision", first.manifest)).toEqual(choices("decision", before));
    expect(simulateExperience(before).ok).toBe(true);
    expect(simulateExperience(first.manifest).ok).toBe(true);
  });

  it("leaves the required live instruction on the dialogue model path", () => {
    const manifest = draft();
    expect(screenEditInstruction(manifest, instruction, "opening")).toEqual({ ok: true });
    expect(groqEditKind(instruction)).toBe("dialogue");
    const target = prepareDialogueTarget(manifest, "opening");
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const context = dialogueEditContext(instruction, target.target, { label: "Primary learners", ageBand: "8-10" });
    expect(context).toContain("Primary learners");
    expect(context).toContain("8-10");
    expect(context).toContain("rewrite-editable-text");
    expect(context).not.toContain("Your goal is to use the source note.");
  });

  it("does not apply a provider refusal or an incomplete response", async () => {
    const refusal = await requestPaidEdit({
      env: freeEnv,
      systemText: "Edit the draft.",
      userText: "Rewrite the opening.",
      retryDelayMs: 0,
      fetchImpl: (async () => Response.json({
        id: "resp_refusal",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }],
        usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      })) as typeof fetch,
    });
    expect(refusal).toMatchObject({ ok: false, code: "unsupported-edit" });
    expect(refusal.content).toBeUndefined();
    expect(refusal.diagnostic).toContain("refusal");
    const incomplete = await requestPaidEdit({
      env: freeEnv,
      systemText: "Edit the draft.",
      userText: "Rewrite the opening.",
      retryDelayMs: 0,
      fetchImpl: (async () => Response.json({
        id: "resp_partial",
        status: "incomplete",
        output: [{ type: "reasoning", content: [] }],
        usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 4 } },
      })) as typeof fetch,
    });
    expect(incomplete).toMatchObject({ ok: false, code: "provider-unavailable" });
    expect(incomplete.content).toBeUndefined();
    expect(incomplete.diagnostic).toContain("incomplete");
  });
});

function assertClosed(schema: unknown) {
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "object") {
      expect(record.additionalProperties).toBe(false);
      if (record.properties && typeof record.properties === "object" && Array.isArray(record.required)) {
        expect([...record.required].sort()).toEqual(Object.keys(record.properties).sort());
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(schema);
}
