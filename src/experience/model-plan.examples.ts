import { randomUUID } from "node:crypto";
import type { GenerationSource } from "./compile";
// Authored transport specimens, not claims of live model output.
export const examples = [
  { title: "Rain garden", facts: ["A rain garden collects runoff in a shallow planted hollow.", "An overflow channel carries excess water away from the path."], choices: ["Route runoff into the planted hollow", "Route runoff onto the path", "Add an overflow channel", "Leave the overflow route closed"], outcomes: ["The hollow collects runoff and excess water has a route away from the path.", "The hollow collects runoff but excess water has no open overflow route.", "Runoff goes onto the path; the overflow channel does not fix that first routing choice.", "Runoff goes onto the path and there is no open overflow channel."] },
  { title: "Archive labels", facts: ["A location label identifies the shelf holding a folder.", "A subject label describes the folder contents."], choices: ["Add the shelf location", "Leave the location blank", "Add the subject description", "Leave the subject blank"], outcomes: ["Visitors can identify both the shelf and the subject from your labels.", "Visitors can identify the shelf but the label does not describe the subject.", "Visitors know the subject but the label does not identify its shelf.", "Neither shelf nor subject can be identified from your blank labels."] },
  { title: "Stage signals", facts: ["In this rehearsal, a blue card signals the curtain to open.", "In this rehearsal, a yellow card signals the music to start."], choices: ["Raise the blue card", "Keep the blue card hidden", "Raise the yellow card", "Keep the yellow card hidden"], outcomes: ["You signal both the curtain opening and the music start.", "You signal the curtain opening but give no signal for music.", "You signal music but give no curtain-opening signal.", "You give neither the curtain nor the music signal."] },
];
export function specimen(example = examples[0]) {
  const spanId = randomUUID();
  const source: GenerationSource = { documentVersionId: randomUUID(), experienceId: randomUUID(), versionId: randomUUID(), topicTitle: example.title, audienceLabel: "Primary learners", ageBand: "8-10", spans: [{ id: spanId, excerpt: example.facts.join(" ") }] };
  const choice = (id: string, text: string, nextSceneId: string, understanding: number) => ({ id, text, nextSceneId, understanding });
  const plan = { learnerObjective: `Apply the two rules about ${example.title}.`, setting: { kind: "fictional", label: `The ${example.title} workshop` }, facts: example.facts.map(claim => ({ kind: "source", claim, spanId })), fictionalElements: ["The workshop"], gameplayObjective: "Complete both tasks using the source rules.", progression: [
    { id: "start", role: "dialogue", title: example.title, text: `This workshop is fictional. ${example.facts.join(" ")}`, choices: [choice("first", example.choices[0], "follow-a", 1), choice("second", example.choices[1], "follow-b", 0)] },
    ...["a", "b"].map((branch, index) => ({ id: `follow-${branch}`, role: "dialogue", title: "The second task", text: `${example.facts[1]} Choose your next action.`, choices: [choice("third", example.choices[2], `end-${index * 2}`, index === 0 ? 2 : 1), choice("fourth", example.choices[3], `end-${index * 2 + 1}`, index === 0 ? 1 : 0)] })),
    ...example.outcomes.map((text, index) => ({ id: `end-${index}`, role: "ending", title: "Your result", text })),
  ] };
  return { source, plan };
}
