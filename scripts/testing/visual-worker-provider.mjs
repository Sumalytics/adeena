import { appendFileSync } from "node:fs";

let calls = 0;
const delayMs = Number(process.env.ADEENA_VISUAL_WORKER_FAKE_DELAY_MS ?? 25);
if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) throw new Error("Invalid fake-provider delay");
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== "https://api.groq.com/openai/v1/responses") return nativeFetch(input, init);
  calls += 1;
  const body = JSON.parse(String(init?.body));
  const context = JSON.parse(typeof body.input === "string" ? body.input : body.input.find((item) => item.role === "user").content);
  let content;
  if (body.text.format.name === "experience_plan") {
    const [first, second] = context.allowedFacts;
    const choice = (id, text, nextSceneId, understanding) => ({ id, text, nextSceneId, understanding });
    content = {
      learnerObjective: "Explain and apply the first two source-supported coffee preparation stages.",
      setting: { kind: "fictional", label: "A fictional coffee workshop" },
      facts: [first, second].map((fact) => ({ kind: "source", claim: fact.claim, spanId: fact.spanId })),
      fictionalElements: ["coffee workshop"], gameplayObjective: "Choose two actions using the source sequence.",
      progression: [
        { id: "start", role: "dialogue", title: "Coffee workshop", text: `This is a fictional scenario. ${first.claim} ${second.claim}`, choices: [choice("use-first", "Begin with the first source stage", "follow-first", 1), choice("use-second", "Begin with the second source stage", "follow-second", 0)] },
        { id: "follow-first", role: "dialogue", title: "Next stage", text: `${second.claim} Choose the next source stage.`, choices: [choice("continue-order", "Continue in source order", "end-ordered", 2), choice("reverse-order", "Reverse the two source stages", "end-reversed", 0)] },
        { id: "follow-second", role: "dialogue", title: "Next stage", text: `${second.claim} Choose the next source stage.`, choices: [choice("return-first", "Return to the first source stage", "end-returned", 1), choice("stay-second", "Stay with the second source stage", "end-skipped", 0)] },
        { id: "end-ordered", role: "ending", title: "Source order", text: "You chose the source-supported order." },
        { id: "end-reversed", role: "ending", title: "Reversed", text: "You reversed the source stages." },
        { id: "end-returned", role: "ending", title: "Returned", text: "You returned to the first source stage." },
        { id: "end-skipped", role: "ending", title: "Skipped", text: "You skipped the first source stage." },
      ],
    };
  } else if (body.text.format.name === "experience_review") {
    content = { grounded: true, coherent: true, consequential: true, audienceSuitable: true, issues: [] };
  } else if (body.text.format.name === "experience_visualPlan") {
    const span = context.excerpts[0];
    const quote = String(span.excerpt).match(/[^.!?]+[.!?]/)?.[0].trim() ?? String(span.excerpt).slice(0, 80);
    const sceneId = context.manifest.scenes[0].id;
    const bind = (elementId) => ({ elementId, outcomeIds: ["ordered-stages"] });
    content = { result: "supported", plan: {
      contract: "ADEENA-INSTRUCTIONAL-PLAN-v1", learnerObjective: context.learningObjective, visualTreatment: "process-pathway@1",
      learningOutcomes: [{ id: "ordered-stages", statement: quote, evidence: { spanId: span.id, quote } }],
      scenes: [{ blueprintSceneId: sceneId, concept: "The ordered preparation stages", representationRationale: "A connected pathway shows the explicit source order.", learnerSees: "Two connected stages from the source sequence.", movementPurpose: "The path highlights movement from the first stage to the next.", narrationPurpose: "Narration states the source sequence while the path is highlighted.", practicePurpose: "The learner restores the source-supported order.", outcomeIds: ["ordered-stages"], objectEvidence: [bind("first-stage"), bind("second-stage"), bind("stage-path")], cueEvidence: [bind("show-path")], narrationEvidence: [bind("stage-narration")], interactionEvidence: bind("order-stages") }],
    }, blueprint: {
      contract: "ADEENA-VISUAL-LEARNING-v1", locale: context.locale, ageBand: context.ageBand, styleId: "friendly-illustrated-2d-v1", voice: { locale: context.locale, voiceProfileId: "educator-neutral-1", style: "calm", rate: 1 },
      scenes: [{ id: sceneId, phase: "practice", archetype: "process-pathway@1", durationMs: 7000, sourceSpanIds: [span.id], visualObjects: [
        { id: "first-stage", kind: "node", nodeType: "step", label: "Ferment", role: "answer-target", geometry: { x: 100, y: 300, width: 180, height: 120 } },
        { id: "second-stage", kind: "node", nodeType: "step", label: "Wash", role: "answer-target", geometry: { x: 650, y: 300, width: 180, height: 120 } },
        { id: "stage-path", kind: "edge", fromId: "first-stage", toId: "second-stage", directed: true, label: "Then", role: "path", geometry: { x: 300, y: 340, width: 320, height: 30 } },
      ], cues: [{ id: "show-path", targetId: "stage-path", trigger: { kind: "narration-segment", segmentId: "stage-narration", offsetMs: 0 }, action: { kind: "highlight" }, durationMs: 500 }], narration: [{ id: "stage-narration", text: quote, caption: quote, onScreenText: null, startMs: 0, durationMs: 5000, cueIds: ["show-path"], sourceSpanIds: [span.id] }], interaction: { id: "order-stages", kind: "sequence-steps", prompt: "Place the stages in the order taught.", itemIds: ["first-stage", "second-stage"], correctOrder: ["first-stage", "second-stage"], feedback: { correct: "That order matches the source.", incorrect: "Use the order stated in the source." }, sourceSpanIds: [span.id] } }],
    }, mapping: { contract: "ADEENA-VISUAL-SCENE-MAPPING-v1", legacyExperienceId: context.manifest.experienceId, scenes: [{ visualSceneId: sceneId, legacySceneId: sceneId }], choices: [] } };
  } else {
    content = { sourceGrounded: true, relationshipsCorrect: true, animationMatchesNarration: true, practiceSupported: true, audienceSuitable: true, capabilitySupported: true, highRiskUncertainty: false, issues: [] };
  }
  if (process.env.ADEENA_VISUAL_WORKER_FAKE_CALL_LOG) appendFileSync(process.env.ADEENA_VISUAL_WORKER_FAKE_CALL_LOG, `${body.text.format.name}\n`);
  process.stdout.write(`[visual-worker-fake] ${body.text.format.name} call ${calls}\n`);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (process.env.ADEENA_VISUAL_WORKER_FAKE_REJECT_VISUAL_PLAN === "1" && body.text.format.name === "experience_visualPlan") {
    return Response.json({ error: { code: "invalid_request_error", message: `Echo ${context.excerpts[0]?.excerpt ?? ""}` } }, { status: 400 });
  }
  return Response.json({ id: `mock_response_${calls}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(content) }] }], usage: { input_tokens: 900, output_tokens: 700, output_tokens_details: { reasoning_tokens: 5 } } });
};


