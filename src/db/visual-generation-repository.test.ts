import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFilesystemObjectStore } from "@/storage/filesystem";
import { openDatabase, type DatabaseClient } from "./client";
import { databaseUrl, applicationDatabaseUrl } from "./env";
import { urlForDatabase } from "./test-database";
import { migrateUp } from "./migrate";
import { createWorkspace } from "./authz";
import { issueIdentityForIsolatedTests } from "./identity";
import { enqueueDurableSource } from "./source-repository";
import { runExtractionOnce } from "./worker";
import { recommendFirstTopic } from "./topic-repository";
import { readVisualExperience } from "./visual-experience-repository";
import { createCreatorWorkflow, selectWorkflowAudience, selectWorkflowSource, selectWorkflowTopic } from "./workflow-repository";
import { creatorWorkflowGenerateResponse, creatorWorkflowGenerationReadResponse } from "@/auth/workflows";
import { sessionFromAuthUser } from "@/auth/subject";

const env = { ADEENA_EXPERIENCE_PROVIDER: "configured-provider", ADEENA_AI_EXECUTION_MODE: "free-development", ADEENA_RUNTIME: "nonproduction-test", ADEENA_GROQ_PLAN: "free", ADEENA_AI_MODEL: "openai/gpt-oss-120b", ADEENA_AI_API_URL: "https://api.groq.com/openai/v1/responses", ADEENA_GROQ_API_KEY: "test-key" };

describe("durable visual AI generation", () => {
  const database = `adeena_visual_test_${randomUUID().replaceAll("-", "")}`;
  let maintenance: DatabaseClient, admin: DatabaseClient, sql: DatabaseClient;
  let root: string;
  beforeAll(async () => {
    maintenance = openDatabase(urlForDatabase(databaseUrl(), "postgres"));
    await maintenance.unsafe(`CREATE DATABASE ${database}`);
    admin = openDatabase(urlForDatabase(databaseUrl(), database));
    sql = openDatabase(urlForDatabase(applicationDatabaseUrl(), database));
    await migrateUp(admin);
    root = await mkdtemp(path.join(tmpdir(), "adeena-visual-model-"));
  });
  afterAll(async () => {
    await sql?.end({ timeout: 1 }); await admin?.end({ timeout: 1 });
    await maintenance.unsafe(`DROP DATABASE ${database}`); await maintenance.end();
    if (root) await rm(root, { recursive: true, force: true });
  }, 20_000);

  it("uses the authorized source version, reserves separate calls, associates once, and replays without billing", async () => {
    const identity = issueIdentityForIsolatedTests(randomUUID());
    const workspaceId = randomUUID();
    await createWorkspace(sql, identity, { id: workspaceId, name: "Visual model test", workspaceType: "personal" });
    const actor = { sql, identity, workspaceId };
    const store = createFilesystemObjectStore(root);
    const sourceText = "Fresh coffee cherries are picked first. The cherries are sorted second. The beans are pulped, fermented, washed, dried, milled, roasted, and packed in that order. Each stage prepares the coffee for the next stage in the stated sequence.";
    const uploaded = await enqueueDurableSource({ ...actor, filename: "coffee.md", bytes: Buffer.from(`# Coffee preparation\n\n## Ordered stages\n\n${sourceText} ${sourceText}`), store, idempotencyKey: randomUUID() });
    await runExtractionOnce({ ...actor, store, leaseOwner: "visual-model-test" });
    const recommended = await recommendFirstTopic({ ...actor, documentVersionId: uploaded.version.id, audienceLabel: "Junior secondary learners", ageBand: "11-13", idempotencyKey: randomUUID() });
    const topicCandidateId = recommended.recommendation?.topicCandidateId;
    if (!topicCandidateId) throw new Error("Visual topic was not selected");
    let workflow = await createCreatorWorkflow({ ...actor, idempotencyKey: randomUUID() });
    workflow = await selectWorkflowSource({ ...actor, workflowId: workflow.id, expectedVersion: workflow.version, documentVersionId: uploaded.version.id });
    workflow = await selectWorkflowAudience({ ...actor, workflowId: workflow.id, expectedVersion: workflow.version, audienceLabel: "Junior secondary learners", ageBand: "11-13" });
    workflow = await selectWorkflowTopic({ ...actor, workflowId: workflow.id, expectedVersion: workflow.version, topicCandidateId });
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      const context = JSON.parse(body.input);
      let content: unknown;
      if (body.text.format.name === "experience_plan") {
        const [first, second] = context.allowedFacts;
        const choice = (id: string, text: string, nextSceneId: string, understanding: number) => ({ id, text, nextSceneId, understanding });
        content = {
          learnerObjective: "Apply the two source-supported preparation steps.",
          setting: { kind: "fictional", label: "A fictional coffee workshop" },
          facts: [first, second].map((fact: { claim: string; spanId: string }) => ({ kind: "source", claim: fact.claim, spanId: fact.spanId })),
          fictionalElements: ["coffee workshop"], gameplayObjective: "Choose two actions using the source sequence.",
          progression: [
            { id: "start", role: "dialogue", title: "Coffee workshop", text: `This is a fictional scenario. ${first.claim} ${second.claim}`, choices: [choice("use-first", "Begin with the first source stage", "follow-first", 1), choice("use-second", "Begin with the second source stage", "follow-second", 0)] },
            { id: "follow-first", role: "dialogue", title: "Next stage", text: `${second.claim} Choose the next source stage.`, choices: [choice("continue-order", "Continue in source order", "end-ordered", 2), choice("reverse-order", "Reverse the two source stages", "end-reversed", 0)] },
            { id: "follow-second", role: "dialogue", title: "Next stage", text: `${second.claim} Choose the next source stage.`, choices: [choice("return-first", "Return to the first source stage", "end-returned", 1), choice("stay-second", "Stay with the second source stage", "end-skipped", 0)] },
            { id: "end-ordered", role: "ending", title: "Source order", text: "You chose the first stage and then continued in source order." },
            { id: "end-reversed", role: "ending", title: "Reversed", text: "You chose the first stage and then reversed the two stages." },
            { id: "end-returned", role: "ending", title: "Returned", text: "You chose the second stage and then returned to the first." },
            { id: "end-skipped", role: "ending", title: "Skipped", text: "You chose the second stage and stayed there." },
          ],
        };
      } else if (body.text.format.name === "experience_review") {
        content = { grounded: true, coherent: true, consequential: true, audienceSuitable: true, issues: [] };
      } else if (body.text.format.name === "experience_visualPlan") {
        const span = context.excerpts[0];
        const quote = String(span.excerpt).match(/[^.!?]+[.!?]/)?.[0].trim() ?? String(span.excerpt).slice(0, 80);
        const bind = (elementId: string) => ({ elementId, outcomeIds: ["ordered-stages"] });
        const sceneId = context.manifest.scenes[0].id;
        content = {
          result: "supported",
          plan: {
            contract: "ADEENA-INSTRUCTIONAL-PLAN-v1", learnerObjective: context.learningObjective, visualTreatment: "process-pathway@1",
            learningOutcomes: [{ id: "ordered-stages", statement: quote, evidence: { spanId: span.id, quote } }],
            scenes: [{ blueprintSceneId: sceneId, concept: "The ordered preparation stages", representationRationale: "A connected pathway shows the explicit source order.", learnerSees: "Two connected stages from the source sequence.", movementPurpose: "The path highlights the movement from the first stage to the next.", narrationPurpose: "Narration states the source sequence while the path is highlighted.", practicePurpose: "The learner restores the source-supported order.", outcomeIds: ["ordered-stages"], objectEvidence: [bind("first-stage"), bind("second-stage"), bind("stage-path")], cueEvidence: [bind("show-path")], narrationEvidence: [bind("stage-narration")], interactionEvidence: bind("order-stages") }],
          },
          blueprint: {
            contract: "ADEENA-VISUAL-LEARNING-v1", locale: context.locale, ageBand: context.ageBand, styleId: "friendly-illustrated-2d-v1", voice: { locale: context.locale, voiceProfileId: "educator-neutral-1", style: "calm", rate: 1 },
            scenes: [{ id: sceneId, phase: "practice", archetype: "process-pathway@1", durationMs: 7000, sourceSpanIds: [span.id], visualObjects: [
              { id: "first-stage", kind: "node", nodeType: "step", label: "First stage", role: "answer-target", geometry: { x: 100, y: 300, width: 180, height: 120 } },
              { id: "second-stage", kind: "node", nodeType: "step", label: "Second stage", role: "answer-target", geometry: { x: 650, y: 300, width: 180, height: 120 } },
              { id: "stage-path", kind: "edge", fromId: "first-stage", toId: "second-stage", directed: true, label: "Then", role: "path", geometry: { x: 300, y: 340, width: 320, height: 30 } },
            ], cues: [{ id: "show-path", targetId: "stage-path", trigger: { kind: "narration-segment", segmentId: "stage-narration", offsetMs: 0 }, action: { kind: "highlight" }, durationMs: 500 }], narration: [{ id: "stage-narration", text: quote, caption: quote, startMs: 0, durationMs: 5000, cueIds: ["show-path"], sourceSpanIds: [span.id] }], interaction: { id: "order-stages", kind: "sequence-steps", prompt: "Place the stages in the order taught.", itemIds: ["first-stage", "second-stage"], correctOrder: ["first-stage", "second-stage"], feedback: { correct: "That order matches the source.", incorrect: "Use the order stated in the source." }, sourceSpanIds: [span.id] } }],
          },
          mapping: { contract: "ADEENA-VISUAL-SCENE-MAPPING-v1", legacyExperienceId: context.manifest.experienceId, scenes: [{ visualSceneId: sceneId, legacySceneId: sceneId }], choices: [] },
        };
      } else content = { sourceGrounded: true, relationshipsCorrect: true, animationMatchesNarration: true, practiceSupported: true, audienceSuitable: true, capabilitySupported: true, highRiskUncertainty: false, issues: [] };
      return Response.json({ id: `visual_resp_${calls}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(content) }] }], usage: { input_tokens: 900, output_tokens: 700, output_tokens_details: { reasoning_tokens: 5 } } });
    };
    const session = sessionFromAuthUser({ id: identity.userId });
    const first = await creatorWorkflowGenerateResponse({ session, sql, workflowId: workflow.id, body: { expectedVersion: workflow.version, authorizeGeneration: true }, provider: "configured-provider", env, fetchImpl });
    expect(first).toMatchObject({ status: 202, body: { generation: { status: "compiling", visualStatus: "queued", stageLabel: "Preparing animated explanation" } } });
    if (!("background" in first) || !first.background) throw new Error("Visual background work was not scheduled");
    const concurrent = await creatorWorkflowGenerateResponse({ session, sql, workflowId: workflow.id, body: { expectedVersion: workflow.version, authorizeGeneration: true }, provider: "configured-provider", env, fetchImpl });
    expect(concurrent).toMatchObject({ status: 202, body: { generation: { visualStatus: "queued" } } });
    expect("background" in concurrent && concurrent.background).toBeFalsy();
    await first.background();
    const completed = await creatorWorkflowGenerationReadResponse({ session, sql, workflowId: workflow.id });
    expect(completed).toMatchObject({ status: 200, body: { generation: { status: "ready", visualStatus: "ready", legacyOnly: false }, workflow: { experienceVersionId: expect.any(String) } } });
    if (!("generation" in completed.body) || !("workflow" in completed.body) || !completed.body.workflow) throw new Error("Generation did not complete");
    const versionId = completed.body.generation?.experienceVersionId;
    if (!versionId) throw new Error("No experience version was completed");
    const replay = await creatorWorkflowGenerateResponse({ session, sql, workflowId: workflow.id, body: { expectedVersion: completed.body.workflow.version, authorizeGeneration: true }, provider: "configured-provider", env, fetchImpl });
    expect(replay).toMatchObject({ status: 200, body: { generation: { status: "ready", visualStatus: "ready" } } });
    expect(calls).toBe(4);
    const visual = await readVisualExperience({ ...actor, experienceVersionId: versionId });
    expect(visual).toMatchObject({ status: "ready", association: { authoredFixture: false, fixtureLabel: null } });
    const [cost] = await admin`select call_count,input_tokens,output_tokens,actual_cost_micros,commercial_estimate_micros from visual_generation_costs`;
    expect(cost).toMatchObject({ call_count: 2, input_tokens: 1800, output_tokens: 1400, actual_cost_micros: 0 });
    expect(cost.commercial_estimate_micros).toBeGreaterThan(0);
    expect(await admin`select id from visual_generation_jobs`).toHaveLength(1);
  }, 30_000);
});
