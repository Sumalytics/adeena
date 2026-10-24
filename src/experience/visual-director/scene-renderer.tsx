import type { CSSProperties, ReactNode } from "react";
import type { VisualArchetypeId, VisualObject, VisualScene } from "./schema";
import { frameAt, type SceneFrame, type VisualObjectState } from "./timeline";
import styles from "./visual-director.module.css";

export type SceneRendererProps = { scene: VisualScene; frame: SceneFrame; reducedMotion: boolean };
type ArchetypeRenderer = (props: SceneRendererProps) => ReactNode;

export const IMPLEMENTED_VISUAL_RENDERERS = {
  "process-pathway@1": ProcessPathway,
  "venn-two-set@1": TwoSetDiagram,
} satisfies Partial<Record<VisualArchetypeId, ArchetypeRenderer>>;

export const IMPLEMENTED_ARCHETYPES = Object.keys(IMPLEMENTED_VISUAL_RENDERERS) as Array<keyof typeof IMPLEMENTED_VISUAL_RENDERERS>;

export function SceneStage({ scene, timeMs, reducedMotion = false }: { scene: VisualScene; timeMs: number; reducedMotion?: boolean }) {
  const frame = frameAt(scene, timeMs, { reducedMotion });
  const Renderer = IMPLEMENTED_VISUAL_RENDERERS[scene.archetype as keyof typeof IMPLEMENTED_VISUAL_RENDERERS] as ArchetypeRenderer | undefined;
  if (!Renderer) {
    return (
      <section className={styles.unsupported} role="status" data-archetype={scene.archetype}>
        <strong>This visual renderer is not available yet.</strong>
        <span>The registered archetype {scene.archetype} remains unsupported in this player.</span>
      </section>
    );
  }
  return (
    <figure className={styles.figure} data-archetype={scene.archetype} data-reduced-motion={reducedMotion ? "true" : "false"}>
      <svg className={styles.stage} viewBox={scene.archetype === "process-pathway@1" ? "0 100 1000 600" : "0 0 1000 1000"} role="img" aria-labelledby={`${scene.id}-title ${scene.id}-description`}>
        <title id={`${scene.id}-title`}>{scene.visualObjects.map((object) => object.label).join(", ")}</title>
        <desc id={`${scene.id}-description`}>{frame.caption ?? "A source-grounded visual explanation."}</desc>
        <defs>
          <linearGradient id={`${scene.id}-surface`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fffdf5" /><stop offset="1" stopColor="#e7f3eb" /></linearGradient>
          <filter id={`${scene.id}-shadow`} x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="8" stdDeviation="10" floodOpacity=".14" /></filter>
          <marker id={`${scene.id}-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker>
        </defs>
        <rect x="10" y="10" width="980" height="980" rx="54" fill={`url(#${scene.id}-surface)`} />
        <Renderer scene={scene} frame={frame} reducedMotion={reducedMotion} />
      </svg>
    </figure>
  );
}

function ProcessPathway({ scene, frame, reducedMotion }: SceneRendererProps) {
  return (
    <g>
      <path d="M70 560 C250 700 710 700 930 530" fill="none" stroke="#d7eadc" strokeWidth="120" strokeLinecap="round" />
      <ObjectLayer scene={scene} frame={frame} reducedMotion={reducedMotion} />
      {!reducedMotion ? <FlowMarker scene={scene} frame={frame} /> : null}
    </g>
  );
}

function FlowMarker({ scene, frame }: { scene: VisualScene; frame: SceneFrame }) {
  const nodes = scene.visualObjects.filter((object) => object.kind === "node");
  if (nodes.length < 2 || frame.timeMs <= 0) return null;
  const portion = frame.progress * (nodes.length - 1);
  const index = Math.min(nodes.length - 2, Math.floor(portion));
  const local = portion - index;
  const from = nodes[index], to = nodes[index + 1];
  if (!from || !to) return null;
  const x = center(from, frame.objects[from.id]).x + (center(to, frame.objects[to.id]).x - center(from, frame.objects[from.id]).x) * local;
  const y = center(from, frame.objects[from.id]).y + (center(to, frame.objects[to.id]).y - center(from, frame.objects[from.id]).y) * local;
  return <g className={styles.flowMarker} transform={`translate(${x} ${y})`}><circle r="31" fill="#f4aa3f" opacity=".2" /><circle r="15" fill="#e77735" /></g>;
}

function TwoSetDiagram({ scene, frame, reducedMotion }: SceneRendererProps) {
  const regions = scene.visualObjects.filter((object) => object.kind === "region");
  const left = regions.find((object) => object.regionType === "inside");
  const right = regions.filter((object) => object.regionType === "inside")[1];
  const overlap = regions.find((object) => object.regionType === "overlap");
  const calculation = scene.interaction?.kind === "calculate" && scene.interaction.answerSpec.operation === "two-set-cardinality" ? scene.interaction.answerSpec : null;
  return (
    <g>
      <rect x="75" y="160" width="850" height="650" rx="45" fill="#fff" stroke="#d4e3d9" strokeWidth="6" />
      <circle cx="400" cy="470" r="255" fill="#76b7d8" fillOpacity=".34" stroke="#2c789d" strokeWidth="9" />
      <circle cx="600" cy="470" r="255" fill="#e9a56c" fillOpacity=".34" stroke="#b95e2d" strokeWidth="9" />
      {left ? <text x="275" y="215" textAnchor="middle" className={styles.regionLabel}>{left.label}</text> : null}
      {overlap ? <text x="500" y="265" textAnchor="middle" className={styles.regionLabel}>{overlap.label}</text> : null}
      {right ? <text x="725" y="215" textAnchor="middle" className={styles.regionLabel}>{right.label}</text> : null}
      {calculation ? (
        <g className={styles.counts} aria-label={`First set ${calculation.setACount}; intersection ${calculation.intersectionCount}; second set ${calculation.setBCount}; union ${calculation.unionCount}.`}>
          <text x="330" y="500" textAnchor="middle">{calculation.setACount - calculation.intersectionCount}</text>
          <text x="500" y="500" textAnchor="middle">{calculation.intersectionCount}</text>
          <text x="670" y="500" textAnchor="middle">{calculation.setBCount - calculation.intersectionCount}</text>
          {calculation.neitherCount !== undefined ? <text x="500" y="760" textAnchor="middle" className={styles.neither}>{calculation.neitherCount} outside both</text> : null}
        </g>
      ) : null}
      <ObjectLayer scene={scene} frame={frame} reducedMotion={reducedMotion} skipKinds={new Set(["region"])} />
    </g>
  );
}

function ObjectLayer({ scene, frame, reducedMotion, skipKinds = new Set<string>() }: SceneRendererProps & { skipKinds?: ReadonlySet<string> }) {
  const objectMap = new Map(scene.visualObjects.map((object) => [object.id, object]));
  return <g>{scene.visualObjects.map((object) => skipKinds.has(object.kind) ? null : <VisualObjectNode key={object.id} object={object} state={frame.objects[object.id]} objectMap={objectMap} frame={frame} reducedMotion={reducedMotion} sceneId={scene.id} />)}</g>;
}

function VisualObjectNode({ object, state, objectMap, frame, reducedMotion, sceneId }: { object: VisualObject; state: VisualObjectState; objectMap: ReadonlyMap<string, VisualObject>; frame: SceneFrame; reducedMotion: boolean; sceneId: string }) {
  if (!state) return null;
  const visualStyle = { "--cue-progress": String(frame.progress) } as CSSProperties;
  const className = [styles.object, state.highlighted && styles.highlighted, state.emphasized && styles.emphasized, state.compared && styles.compared].filter(Boolean).join(" ");
  if (object.kind === "edge") {
    const from = objectMap.get(object.fromId), to = objectMap.get(object.toId);
    if (!from || !to || !state.connected) return null;
    const { a, b } = edgeEndpoints(from, frame.objects[from.id], to, frame.objects[to.id]);
    return <g className={className} data-object-id={object.id} data-visible={state.visible} data-state={state.state}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={styles.edge} markerEnd={object.directed ? `url(#${sceneId}-arrow)` : undefined} /><text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 55} textAnchor="middle" className={styles.edgeLabel}>{object.label}</text></g>;
  }
  const transform = `translate(${state.x} ${state.y})`;
  const opacity = state.visible ? 1 : 0;
  const transition = reducedMotion ? undefined : `opacity 180ms ease, transform 180ms ease`;
  if (object.kind === "quantity") return <g className={className} transform={transform} opacity={opacity} style={{ ...visualStyle, transition }} data-object-id={object.id} data-state={state.state} data-x={Math.round(state.x)} data-y={Math.round(state.y)}><circle cx={object.geometry.width / 2} cy={object.geometry.height / 2} r="52" className={styles.quantity} /><text x={object.geometry.width / 2} y={object.geometry.height / 2 + 10} textAnchor="middle" className={styles.quantityText}>{object.value}</text><text x={object.geometry.width / 2} y={object.geometry.height + 28} textAnchor="middle" className={styles.objectLabel}>{object.label}</text></g>;
  if (object.kind === "text") return <text x={state.x} y={state.y} opacity={opacity} className={styles.objectLabel} data-object-id={object.id}>{object.text}</text>;
  if (object.kind === "shape") return <ShapeObject object={object} state={state} className={className} />;
  if (object.kind === "region") return <rect x={state.x} y={state.y} width={object.geometry.width} height={object.geometry.height} rx="30" opacity={opacity} className={`${styles.region} ${className}`} data-object-id={object.id} />;
  if (object.kind === "group") return <g className={className} opacity={opacity} data-object-id={object.id} data-state={state.state}><rect x={state.x} y={state.y} width={object.geometry.width} height={object.geometry.height} rx="30" className={styles.groupOutline} /><text x={state.x + 18} y={state.y + 30} className={styles.edgeLabel}>{object.label}</text></g>;
  return (
    <g className={className} transform={transform} opacity={opacity} style={{ ...visualStyle, transition }} data-object-id={object.id} data-visible={state.visible} data-state={state.state}>
      <rect width={object.geometry.width} height={object.geometry.height} rx="28" className={styles.node} filter={`url(#${sceneId}-shadow)`} />
      <circle cx="34" cy={object.geometry.height / 2} r="12" className={styles.nodeDot} />
      <text x={object.geometry.width / 2 + 8} y={object.geometry.height / 2 + 7} textAnchor="middle" className={styles.objectLabel}>{object.label}</text>
    </g>
  );
}

function ShapeObject({ object, state, className }: { object: Extract<VisualObject, { kind: "shape" }>; state: VisualObjectState; className: string }) {
  if (object.shape === "circle" || object.shape === "ellipse") return <ellipse cx={state.x + object.geometry.width / 2} cy={state.y + object.geometry.height / 2} rx={object.geometry.width / 2} ry={object.geometry.height / 2} className={`${styles.shape} ${className}`} data-object-id={object.id} />;
  if (object.shape === "line") return <line x1={state.x} y1={state.y} x2={state.x + object.geometry.width} y2={state.y + object.geometry.height} className={`${styles.edge} ${className}`} data-object-id={object.id} />;
  return <rect x={state.x} y={state.y} width={object.geometry.width} height={object.geometry.height} rx={object.shape === "container" ? 28 : 4} className={`${styles.shape} ${className}`} data-object-id={object.id} />;
}

function center(object: VisualObject, state: VisualObjectState) {
  return { x: state.x + object.geometry.width / 2, y: state.y + object.geometry.height / 2 };
}

function edgeEndpoints(from: VisualObject, fromState: VisualObjectState, to: VisualObject, toState: VisualObjectState) {
  const fromCenter = center(from, fromState), toCenter = center(to, toState);
  const dx = toCenter.x - fromCenter.x, dy = toCenter.y - fromCenter.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const unitX = dx / distance, unitY = dy / distance;
  const fromInset = Math.min(from.geometry.width, from.geometry.height) / 2 + 8;
  const toInset = Math.min(to.geometry.width, to.geometry.height) / 2 + 18;
  return {
    a: { x: fromCenter.x + unitX * fromInset, y: fromCenter.y + unitY * fromInset },
    b: { x: toCenter.x - unitX * toInset, y: toCenter.y - unitY * toInset },
  };
}

