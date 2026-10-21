import type { ExperienceManifest } from "@adeena/experience-schema";
import { z } from "zod";
import { describeEditIssue, parseModelEdit, type DialogueTarget } from "./edit";

type JsonSchema = { [key: string]: string | number | boolean | null | string[] | JsonSchema | JsonSchema[] };

const DialogueOne = z.object({ sceneId: z.string(), text: z.string() }).strict();
const DialogueMany = z.object({ sceneId: z.string(), parts: z.array(z.string()).min(2).max(8) }).strict();
const GraphTransport = z.object({ sceneId: z.string(), choiceId: z.string(), nextSceneId: z.string() }).strict();

export function groqTransportSchema(sceneId?: string, partCount = 1) {
  const scene: JsonSchema = sceneId ? { type: "string", enum: [sceneId] } : { type: "string" };
  if (partCount > 1) {
    return {
      type: "object",
      additionalProperties: false,
      required: ["sceneId", "parts"],
      properties: {
        sceneId: scene,
        parts: { type: "array", items: { type: "string" } },
      },
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["sceneId", "text"],
    properties: {
      sceneId: scene,
      text: { type: "string" },
    },
  };
}

export function groqGraphTransportSchema(manifest: Pick<ExperienceManifest, "scenes">) {
  const sceneIds = manifest.scenes.map((scene) => scene.id);
  const choiceIds = manifest.scenes.flatMap((scene) => scene.role === "dialogue" ? scene.choices.map((choice) => choice.id) : []);
  const identifier = (values: string[]): JsonSchema => values.length > 0 ? { type: "string", enum: values } : { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["sceneId", "choiceId", "nextSceneId"],
    properties: {
      sceneId: identifier(sceneIds),
      choiceId: identifier(choiceIds),
      nextSceneId: identifier(sceneIds),
    },
  };
}

export type GroqAssistantRead =
  | { ok: true; payload: unknown }
  | { ok: false; status: "incomplete" | "failed" | "invalid" | "refusal"; diagnostic: string };

export function readGroqAssistantPayload(envelope: unknown): GroqAssistantRead {
  if (!envelope || typeof envelope !== "object") return { ok: false, status: "invalid", diagnostic: "response:invalid_type:expected_object:actual_undefined" };
  const status = "status" in envelope ? envelope.status : undefined;
  if (status === "incomplete" || status === "failed") return { ok: false, status, diagnostic: `response.status:invalid_value:expected_completed:actual_${status}` };
  if (status !== "completed") return { ok: false, status: "invalid", diagnostic: "response.status:invalid_value:expected_completed:actual_missing" };
  if (!("output" in envelope) || !Array.isArray(envelope.output)) return { ok: false, status: "invalid", diagnostic: "output:invalid_type:expected_array:actual_missing" };
  const messages = envelope.output.filter((item) => item && typeof item === "object" && "type" in item && item.type === "message");
  if (messages.length === 0) return { ok: false, status: "invalid", diagnostic: "message:too_small:expected_min_1:actual_array(0)" };
  if (messages.length !== 1) return { ok: false, status: "invalid", diagnostic: `message:too_big:expected_max_1:actual_array(${messages.length})` };
  const message = messages[0];
  if (!message || typeof message !== "object") return { ok: false, status: "invalid", diagnostic: "message:invalid_type:expected_object:actual_undefined" };
  if ("role" in message && message.role !== "assistant") return { ok: false, status: "invalid", diagnostic: "message.role:invalid_value:expected_assistant:actual_other" };
  if (!("content" in message) || !Array.isArray(message.content)) return { ok: false, status: "invalid", diagnostic: "message.content:invalid_type:expected_array:actual_missing" };
  const content: unknown[] = message.content;
  if (content.some((part) => part && typeof part === "object" && "type" in part && part.type === "refusal")) {
    return { ok: false, status: "refusal", diagnostic: "message.content:refusal:expected_output_text:actual_refusal" };
  }
  const texts = content.filter((part): part is { text: string } => Boolean(
    part && typeof part === "object" && "type" in part && part.type === "output_text" && "text" in part && typeof part.text === "string",
  ));
  if (texts.length === 0) return { ok: false, status: "invalid", diagnostic: "output_text:too_small:expected_min_1:actual_array(0)" };
  if (texts.length !== 1) return { ok: false, status: "invalid", diagnostic: `output_text:too_big:expected_max_1:actual_array(${texts.length})` };
  const text = texts[0]?.text.trim() ?? "";
  if (!text.startsWith("{") || !text.endsWith("}")) return { ok: false, status: "invalid", diagnostic: "output_text:invalid_type:expected_json_object:actual_text" };
  try {
    const payload = JSON.parse(text) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, status: "invalid", diagnostic: "output_text:invalid_type:expected_object:actual_other" };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, status: "invalid", diagnostic: "output_text:invalid_type:expected_json_object:actual_malformed" };
  }
}

export function mapGroqTransport(payload: unknown, target?: DialogueTarget) {
  const many = target ? target.editableParts.length > 1 : false;
  const transport = (many ? DialogueMany : DialogueOne).safeParse(payload);
  if (!transport.success) return { ok: false as const, code: "invalid-experience" as const, diagnostic: describeEditIssue(transport.error.issues[0]) };
  const sceneId = transport.data.sceneId;
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(sceneId)) return { ok: false as const, code: "invalid-experience" as const, diagnostic: `sceneId:invalid_format:expected_scene_id:actual_${receivedId(sceneId)}` };
  if (target && sceneId !== target.sceneId) return { ok: false as const, code: "invalid-experience" as const, diagnostic: `sceneId:invalid_value:expected_${target.sceneId}:actual_${receivedId(sceneId)}` };
  const parts = "parts" in transport.data ? transport.data.parts : [transport.data.text];
  const restored = target ? target.restore(parts) : { ok: true as const, text: parts.join(" ") };
  if (!restored.ok) return { ok: false as const, code: "invalid-experience" as const, diagnostic: restored.diagnostic };
  const canonical = parseModelEdit({
    intent: "Rewrite the editable dialogue.",
    scope: "scene",
    gameplayChange: false,
    factualChange: false,
    objectiveChange: false,
    uncertainty: null,
    reviewRequirements: [],
    operations: [{ op: "rewrite-text", sceneId, text: restored.text }],
  });
  if (!canonical.ok) return { ok: false as const, code: "invalid-experience" as const, diagnostic: canonical.diagnostic };
  return { ok: true as const, edit: canonical.edit };
}

export function mapGroqGraphTransport(payload: unknown) {
  const transport = GraphTransport.safeParse(payload);
  if (!transport.success) return { ok: false as const, code: "invalid-experience" as const, diagnostic: describeEditIssue(transport.error.issues[0]) };
  for (const [field, value] of Object.entries(transport.data)) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(value)) return { ok: false as const, code: "invalid-experience" as const, diagnostic: `${field}:invalid_format:expected_scene_id:actual_${receivedId(value)}` };
  }
  const canonical = parseModelEdit({
    intent: "Retarget one existing choice.",
    scope: "scene",
    gameplayChange: true,
    factualChange: false,
    objectiveChange: false,
    uncertainty: null,
    reviewRequirements: [],
    operations: [{ op: "retarget-choice", ...transport.data }],
  });
  if (!canonical.ok) return { ok: false as const, code: "invalid-experience" as const, diagnostic: canonical.diagnostic };
  return { ok: true as const, edit: canonical.edit };
}

function receivedId(value: string) {
  return /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : `string(${value.length})`;
}
