import type { $ZodIssue } from "zod/v4/core";
import { diagnostic, type Diagnostic } from "./diagnostics";
import type { ExperienceManifest } from "./manifest";

const ASSET_LOCATOR =
  /^(synthetic:[a-z0-9][a-z0-9-]{0,40}|assets\/[a-z0-9][a-z0-9-]*\.(svg|png|webp|mp3|wav|vtt|txt))$/;
const SOURCE_LOCATOR = /^synthetic:[a-z0-9][a-z0-9-]{0,60}$/;

export function zodDiagnostics(issues: readonly $ZodIssue[]): Diagnostic[] {
  return issues.map((issue) => {
    const path = issue.path.filter(
      (part): part is string | number => typeof part === "string" || typeof part === "number",
    );
    if (issue.code === "unrecognized_keys") {
      return diagnostic("schema.unknown-field", path, issue.message);
    }
    if (issue.message === "content.executable") {
      return diagnostic("content.executable", path, "Executable content is not allowed");
    }
    if (path[0] === "schema" || path[0] === "schemaVersion") {
      return diagnostic("schema.unsupported-version", path, issue.message);
    }
    if (path[0] === "mechanics") {
      return diagnostic("mechanic.unsupported", path, issue.message);
    }
    if (path[0] === "events") {
      return diagnostic("events.unsupported-version", path, issue.message);
    }
    if (path.includes("effects") && (issue.code === "invalid_union" || issue.code === "invalid_value")) {
      return diagnostic("state.effect-unsupported", path, issue.message);
    }
    if (issue.code === "too_big" || issue.code === "too_small") {
      return diagnostic("bound.exceeded", path, issue.message);
    }
    return diagnostic("schema.invalid", path, issue.message);
  });
}

export function semanticDiagnostics(manifest: ExperienceManifest): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const scenes = manifest.scenes;
  const indexById = new Map<string, number>();
  scenes.forEach((scene, index) => {
    if (indexById.has(scene.id)) {
      diagnostics.push(diagnostic("scene.duplicate", ["scenes", index, "id"], `Scene ${scene.id} is duplicated`));
    } else {
      indexById.set(scene.id, index);
    }
  });

  const variables = new Map(manifest.state.variables.map((variable) => [variable.id, variable]));
  const variableIds = new Set<string>();
  manifest.state.variables.forEach((variable, index) => {
    const path = ["state", "variables", index];
    if (variableIds.has(variable.id)) {
      diagnostics.push(diagnostic("state.duplicate", [...path, "id"], `Variable ${variable.id} is duplicated`));
    }
    variableIds.add(variable.id);
    if (variable.min > variable.max || variable.initial < variable.min || variable.initial > variable.max) {
      diagnostics.push(diagnostic("state.out-of-bounds", path, `Variable ${variable.id} is outside its bounds`));
    }
  });

  const assetIds = new Set<string>();
  manifest.assets.forEach((asset, index) => {
    if (assetIds.has(asset.id)) {
      diagnostics.push(diagnostic("asset.invalid", ["assets", index, "id"], `Asset ${asset.id} is duplicated`));
    }
    assetIds.add(asset.id);
    if (!ASSET_LOCATOR.test(asset.locator) || asset.locator.includes("..")) {
      diagnostics.push(diagnostic("asset.invalid", ["assets", index, "locator"], "Asset locator is not an allowlisted local reference"));
    }
  });

  manifest.sources.forEach((source, index) => {
    if (!SOURCE_LOCATOR.test(source.locator)) {
      diagnostics.push(diagnostic("source.invalid", ["sources", index, "locator"], "Source locator must be a synthetic reference"));
    }
  });

  if (!indexById.has(manifest.initialSceneId)) {
    diagnostics.push(diagnostic("scene.initial-missing", ["initialSceneId"], "Initial scene does not exist"));
  }

  const endings = scenes.filter((scene) => scene.role === "ending");
  if (endings.length === 0) {
    diagnostics.push(diagnostic("ending.missing", ["scenes"], "At least one ending scene is required"));
  }

  const outgoing = new Map<string, string[]>();
  scenes.forEach((scene, sceneIndex) => {
    const next: string[] = [];
    scene.assetIds.forEach((assetId, assetIndex) => {
      if (!assetIds.has(assetId)) {
        diagnostics.push(diagnostic("asset.unknown", ["scenes", sceneIndex, "assetIds", assetIndex], `Unknown asset ${assetId}`));
      }
    });
    if (scene.role === "ending") {
      outgoing.set(scene.id, []);
      return;
    }
    const choiceIds = new Set<string>();
    scene.choices.forEach((choice, choiceIndex) => {
      const choicePath = ["scenes", sceneIndex, "choices", choiceIndex];
      if (choiceIds.has(choice.id)) {
        diagnostics.push(diagnostic("choice.duplicate", [...choicePath, "id"], `Choice ${choice.id} is duplicated`));
      }
      choiceIds.add(choice.id);
      if (!indexById.has(choice.nextSceneId)) {
        diagnostics.push(diagnostic("scene.transition-missing", [...choicePath, "nextSceneId"], `Scene ${choice.nextSceneId} does not exist`));
      } else {
        next.push(choice.nextSceneId);
      }
      choice.effects.forEach((effect, effectIndex) => {
        const variable = variables.get(effect.variableId);
        const effectPath = [...choicePath, "effects", effectIndex];
        if (!variable) {
          diagnostics.push(diagnostic("state.unknown-variable", [...effectPath, "variableId"], `Unknown variable ${effect.variableId}`));
          return;
        }
        if (effect.type === "adjust") {
          const span = variable.max - variable.min;
          if (effect.delta === 0 || Math.abs(effect.delta) > span) {
            diagnostics.push(diagnostic("state.out-of-bounds", [...effectPath, "delta"], `Adjustment for ${variable.id} exceeds its declared span`));
          }
        } else if (effect.value < variable.min || effect.value > variable.max) {
          diagnostics.push(diagnostic("state.out-of-bounds", [...effectPath, "value"], `Value for ${variable.id} is outside its bounds`));
        }
      });
    });
    if (scene.retry) {
      if (!indexById.has(scene.retry.onExhaustedSceneId)) {
        diagnostics.push(
          diagnostic(
            "scene.transition-missing",
            ["scenes", sceneIndex, "retry", "onExhaustedSceneId"],
            `Scene ${scene.retry.onExhaustedSceneId} does not exist`,
          ),
        );
      } else {
        next.push(scene.retry.onExhaustedSceneId);
      }
    }
    outgoing.set(scene.id, next);
  });

  const referencedAssets = new Set(scenes.flatMap((scene) => scene.assetIds));
  manifest.assets.forEach((asset, index) => {
    if (!referencedAssets.has(asset.id)) {
      diagnostics.push(diagnostic("asset.unused", ["assets", index, "id"], `Asset ${asset.id} is not referenced`, "warning"));
    }
  });

  if (!indexById.has(manifest.initialSceneId)) return diagnostics;

  const reachable = forwardReachable(manifest.initialSceneId, outgoing);
  scenes.forEach((scene, index) => {
    if (reachable.has(scene.id)) return;
    diagnostics.push(
      diagnostic(
        scene.required ? "scene.unreachable-required" : "scene.unreachable-optional",
        ["scenes", index, "id"],
        `Scene ${scene.id} is not reachable from the initial scene`,
        scene.required ? "error" : "warning",
      ),
    );
  });

  const reachableEndings = endings.filter((scene) => reachable.has(scene.id));
  if (endings.length > 0 && reachableEndings.length === 0) {
    diagnostics.push(diagnostic("ending.unreachable", ["scenes"], "No ending is reachable from the initial scene"));
  }

  const reachesEnding = reverseReachable(
    new Set(endings.map((scene) => scene.id)),
    outgoing,
  );
  for (const component of stronglyConnected([...indexById.keys()], outgoing)) {
    const cyclic =
      component.length > 1 || (outgoing.get(component[0]) ?? []).includes(component[0]);
    if (!cyclic) continue;
    if (component.some((sceneId) => reachesEnding.has(sceneId))) continue;
    diagnostics.push(
      diagnostic(
        "graph.cycle-without-exit",
        ["scenes", indexById.get(component[0]) ?? 0, "id"],
        "A cycle has no path to an ending and no bounded retry exit",
      ),
    );
  }

  return diagnostics;
}

function forwardReachable(start: string, outgoing: Map<string, string[]>) {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const sceneId = queue.pop()!;
    if (seen.has(sceneId)) continue;
    seen.add(sceneId);
    for (const next of outgoing.get(sceneId) ?? []) queue.push(next);
  }
  return seen;
}

function reverseReachable(goals: Set<string>, outgoing: Map<string, string[]>) {
  const incoming = new Map<string, string[]>();
  for (const [sceneId, nextIds] of outgoing) {
    for (const next of nextIds) {
      const list = incoming.get(next) ?? [];
      list.push(sceneId);
      incoming.set(next, list);
    }
  }
  return forwardReachableFrom(goals, incoming);
}

function forwardReachableFrom(starts: Iterable<string>, outgoing: Map<string, string[]>) {
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const sceneId = queue.pop()!;
    if (seen.has(sceneId)) continue;
    seen.add(sceneId);
    for (const next of outgoing.get(sceneId) ?? []) queue.push(next);
  }
  return seen;
}

function stronglyConnected(nodes: string[], outgoing: Map<string, string[]>) {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const components: string[][] = [];

  function connect(node: string) {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of outgoing.get(node) ?? []) {
      if (!indices.has(next)) {
        connect(next);
        low.set(node, Math.min(low.get(node) ?? index, low.get(next) ?? index));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? index, indices.get(next) ?? index));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component: string[] = [];
      let member = "";
      do {
        member = stack.pop() ?? "";
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component);
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) connect(node);
  }
  return components;
}
