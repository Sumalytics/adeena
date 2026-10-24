import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { parseManifest, type ExperienceManifest } from "@adeena/experience-schema";
import { creatorAudioSource } from "@/audio/contract";
import {
  StoredVisualContextV1, VISUAL_RENDERER_VERSION, VisualExperienceAssociationV1,
  VisualNarrationBindingV1, VisualSceneMappingV1, type StoredVisualContext, type VisualSceneMapping,
  type CreatorVisualExperience,
} from "@/experience/visual-director/association";
import { ARCHETYPE_REGISTRY, NarrationPlaybackTrackV1, validateVisualBlueprint, type VisualLearningBlueprint } from "@/experience/visual-director/schema";
import { authoredProcessFixture } from "@/experience/visual-director/fixtures";
import { SourceError } from "@/source/errors";
import { withWorkspace } from "./authz";
import type { VerifiedIdentity } from "./identity";

const IMPLEMENTED = Object.entries(ARCHETYPE_REGISTRY).filter(([, value]) => value.renderer === "implemented").map(([id]) => id) as StoredVisualContext["implementedArchetypes"];
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a.localeCompare(b))) : item);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

function mappingIsValid(mapping: VisualSceneMapping, blueprint: VisualLearningBlueprint, manifest: ExperienceManifest) {
  if (mapping.legacyExperienceId !== manifest.experienceId) return false;
  const visualScenes = new Set(blueprint.scenes.map((scene) => scene.id));
  const legacyScenes = new Map(manifest.scenes.map((scene) => [scene.id, scene]));
  if (mapping.scenes.length !== visualScenes.size || new Set(mapping.scenes.map((item) => item.visualSceneId)).size !== mapping.scenes.length) return false;
  if (mapping.scenes.some((item) => !visualScenes.has(item.visualSceneId) || !legacyScenes.has(item.legacySceneId))) return false;
  const mappedScene = new Map(mapping.scenes.map((item) => [item.visualSceneId, item.legacySceneId]));
  const visualChoiceIds = new Set(blueprint.scenes.flatMap((scene) => scene.cues.flatMap((cue) => cue.trigger.kind === "choice-applied" ? [`${scene.id}:${cue.trigger.choiceId}`] : [])));
  const mappedChoices = new Set(mapping.choices.map((item) => `${item.visualSceneId}:${item.visualChoiceId}`));
  if (visualChoiceIds.size !== mappedChoices.size || [...visualChoiceIds].some((id) => !mappedChoices.has(id))) return false;
  return mapping.choices.every((item) => {
    const legacy = legacyScenes.get(mappedScene.get(item.visualSceneId) ?? "");
    return legacy?.role === "dialogue" && legacy.choices.some((choice) => choice.id === item.legacyChoiceId);
  });
}

export async function associateVisualExperience(input: {
  sql: Sql; identity: VerifiedIdentity; workspaceId: string; experienceVersionId: string; blueprint: unknown;
  context: unknown; mapping: unknown; authoredFixture?: boolean; fixtureLabel?: string | null;
}) {
  const context = StoredVisualContextV1.parse(input.context);
  const mapping = VisualSceneMappingV1.parse(input.mapping);
  const validated = validateVisualBlueprint(input.blueprint, context);
  if (!validated.ok) throw new SourceError("invalid-experience");
  return withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
    const rows = await workspace.tx<{ manifest: unknown; source_span_ids: unknown }[]>`select manifest,source_span_ids from experience_versions where id=${input.experienceVersionId}::uuid and workspace_id=${input.workspaceId}::uuid`;
    const version = rows[0];
    const manifest = parseManifest(version?.manifest);
    if (!version || !manifest.ok || !mappingIsValid(mapping, validated.blueprint, manifest.manifest)) throw new SourceError("invalid-experience");
    const versionSpans = new Set(Array.isArray(version.source_span_ids) ? version.source_span_ids.filter((id): id is string => typeof id === "string") : []);
    if (context.sourceSpanIds.some((id) => !versionSpans.has(id))) throw new SourceError("invalid-experience");
    const blueprintHash = hash(validated.blueprint);
    const id = randomUUID();
    const inserted = await workspace.tx<{ id: string }[]>`insert into visual_experience_blueprints(
      id,workspace_id,experience_version_id,contract,blueprint,blueprint_hash,validation_context,scene_mapping,validation_status,
      blueprint_contract,renderer_version,authored_fixture,fixture_label,created_by
    ) values(${id}::uuid,${input.workspaceId}::uuid,${input.experienceVersionId}::uuid,'ADEENA-VISUAL-EXPERIENCE-ASSOCIATION-v1',
      ${JSON.stringify(validated.blueprint)}::jsonb,${blueprintHash},${JSON.stringify(context)}::jsonb,${JSON.stringify(mapping)}::jsonb,'valid',
      'ADEENA-VISUAL-LEARNING-v1',${VISUAL_RENDERER_VERSION},${input.authoredFixture === true},${input.fixtureLabel ?? null},${workspace.userId}::uuid)
      on conflict(workspace_id,experience_version_id) do nothing returning id::text`;
    if (!inserted[0]) {
      const existing = await workspace.tx<{ id: string; blueprint_hash: string }[]>`select id::text,blueprint_hash from visual_experience_blueprints where workspace_id=${input.workspaceId}::uuid and experience_version_id=${input.experienceVersionId}::uuid`;
      if (existing[0]?.blueprint_hash !== blueprintHash) throw new SourceError("invalid-experience");
      return { associationId: existing[0].id, replayed: true };
    }
    return { associationId: inserted[0].id, replayed: false };
  });
}

export async function bindVisualNarration(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; experienceVersionId: string; associationId: string; segmentId: string; audioAssetId: string; playback: unknown }) {
  const playback = NarrationPlaybackTrackV1.parse(input.playback);
  if (playback.segmentId !== input.segmentId || playback.audioAssetId !== input.audioAssetId) throw new SourceError("invalid-experience");
  return withWorkspace(input.sql,input.identity,input.workspaceId,async({tx}) => {
    const rows = await tx<{ blueprint: unknown; validation_context: unknown; locale:string; voice_profile_ref:string }[]>`select b.blueprint,b.validation_context,a.locale,a.voice_profile_ref from visual_experience_blueprints b join private_audio_assets a on a.id=${input.audioAssetId}::uuid and a.workspace_id=b.workspace_id and a.experience_version_id=b.experience_version_id and a.status='active' where b.id=${input.associationId}::uuid and b.workspace_id=${input.workspaceId}::uuid and b.experience_version_id=${input.experienceVersionId}::uuid`;
    const parsed = rows[0] ? validateVisualBlueprint(rows[0].blueprint, StoredVisualContextV1.parse(rows[0].validation_context)) : null;
    if (!parsed?.ok) throw new SourceError("invalid-experience");
    if(rows[0].locale!==parsed.blueprint.locale||rows[0].voice_profile_ref!==parsed.blueprint.voice.voiceProfileId)throw new SourceError("invalid-experience");
    const segment = parsed.blueprint.scenes.flatMap((scene) => scene.narration).find((item) => item.id === input.segmentId);
    if (!segment || playback.captions.length !== 1 || playback.captions[0]?.text !== segment.caption) throw new SourceError("invalid-experience");
    const inserted = await tx`insert into visual_experience_audio(association_id,workspace_id,experience_version_id,narration_segment_id,audio_asset_id,playback_metadata)
      values(${input.associationId}::uuid,${input.workspaceId}::uuid,${input.experienceVersionId}::uuid,${input.segmentId},${input.audioAssetId}::uuid,${JSON.stringify(playback)}::jsonb)
      on conflict(association_id,narration_segment_id) do nothing returning narration_segment_id`;
    if (!inserted[0]) {
      const existing = await tx<{ audio_asset_id: string }[]>`select audio_asset_id::text from visual_experience_audio where association_id=${input.associationId}::uuid and narration_segment_id=${input.segmentId}`;
      if (existing[0]?.audio_asset_id !== input.audioAssetId) throw new SourceError("invalid-experience");
    }
    return true;
  });
}

export async function readVisualExperience(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; experienceVersionId: string }): Promise<CreatorVisualExperience | null> {
  return withWorkspace(input.sql,input.identity,input.workspaceId,async({tx}) => {
    const rows = await tx<{ id:string; blueprint:unknown; blueprint_hash:string; validation_context:unknown; scene_mapping:unknown; renderer_version:string; authored_fixture:boolean; fixture_label:string|null; manifest:unknown }[]>`
      select b.id::text,b.blueprint,b.blueprint_hash,b.validation_context,b.scene_mapping,b.renderer_version,b.authored_fixture,b.fixture_label,v.manifest
      from visual_experience_blueprints b join experience_versions v on v.id=b.experience_version_id and v.workspace_id=b.workspace_id
      where b.workspace_id=${input.workspaceId}::uuid and b.experience_version_id=${input.experienceVersionId}::uuid`;
    const row=rows[0];
    if(!row) return null;
    if(row.renderer_version!==VISUAL_RENDERER_VERSION) return { status:"unsupported" as const, message:"This animated experience needs a newer renderer. The original private draft is still available." };
    const context=StoredVisualContextV1.safeParse(row.validation_context), mapping=VisualSceneMappingV1.safeParse(row.scene_mapping), manifest=parseManifest(row.manifest);
    if(!context.success||!mapping.success||!manifest.ok||hash(row.blueprint)!==row.blueprint_hash) return { status:"invalid" as const, message:"This animation could not be verified. The original private draft is still available." };
    const validated=validateVisualBlueprint(row.blueprint,{...context.data,implementedArchetypes:IMPLEMENTED});
    if(!validated.ok) return { status:validated.diagnostics.some((item)=>item.code==="archetype.not-implemented")?"unsupported" as const:"invalid" as const,message:"This animation is not supported by the current player. The original private draft is still available." };
    if(!mappingIsValid(mapping.data,validated.blueprint,manifest.manifest)) return { status:"invalid" as const,message:"The animation no longer matches this experience version. The original private draft is still available." };
    const audio=await tx<{ narration_segment_id:string; playback_metadata:unknown; audio_asset_id:string }[]>`select a.narration_segment_id,a.playback_metadata,a.audio_asset_id::text from visual_experience_audio a join private_audio_assets p on p.id=a.audio_asset_id and p.workspace_id=a.workspace_id and p.experience_version_id=a.experience_version_id and p.status='active' where a.association_id=${row.id}::uuid and a.workspace_id=${input.workspaceId}::uuid and a.experience_version_id=${input.experienceVersionId}::uuid`;
    const bindings=audio.flatMap((item)=>{const parsed=VisualNarrationBindingV1.safeParse({segmentId:item.narration_segment_id,playback:item.playback_metadata,source:creatorAudioSource(item.audio_asset_id)});return parsed.success?[parsed.data]:[];});
    const association=VisualExperienceAssociationV1.parse({contract:"ADEENA-VISUAL-EXPERIENCE-ASSOCIATION-v1",associationId:row.id,experienceVersionId:input.experienceVersionId,blueprintHash:row.blueprint_hash,rendererVersion:row.renderer_version,authoredFixture:row.authored_fixture,fixtureLabel:row.fixture_label,blueprint:validated.blueprint,mapping:mapping.data});
    return { status:"ready" as const, association, narration:bindings };
  });
}

export async function authoredProcessAssociation(input:{sql:Sql;identity:VerifiedIdentity;workspaceId:string;experienceVersionId:string}){
  const prepared=await withWorkspace(input.sql,input.identity,input.workspaceId,async({tx})=>{
    const rows=await tx<{manifest:unknown;source_span_ids:unknown;age_band:string;source_text:string}[]>`select v.manifest,v.source_span_ids,coalesce(j.age_band,'unspecified') as age_band,coalesce(string_agg(s.generation_excerpt,' '),'') as source_text from experience_versions v left join experience_generation_jobs j on j.id=v.job_id left join source_spans s on s.id::text in(select jsonb_array_elements_text(v.source_span_ids)) where v.id=${input.experienceVersionId}::uuid and v.workspace_id=${input.workspaceId}::uuid group by v.id,j.age_band`;
    const row=rows[0], manifest=parseManifest(row?.manifest);
    if(!row||!manifest.ok||!/(trachea|windpipe)/i.test(row.source_text)||!/(bronch|airway)/i.test(row.source_text)||!/(alveol|air sac)/i.test(row.source_text)) throw new SourceError("invalid-experience");
    const spans=Array.isArray(row.source_span_ids)?row.source_span_ids.filter((id):id is string=>typeof id==="string"):[];
    if(!spans[0]) throw new SourceError("invalid-experience");
    const blueprint=structuredClone(authoredProcessFixture);
    blueprint.locale=manifest.manifest.locale; blueprint.voice.locale=manifest.manifest.locale; blueprint.ageBand=row.age_band as typeof blueprint.ageBand;
    for(const scene of blueprint.scenes){scene.sourceSpanIds=[spans[0]];for(const segment of scene.narration)segment.sourceSpanIds=[spans[0]];if(scene.interaction)scene.interaction.sourceSpanIds=[spans[0]];}
    const legacy=manifest.manifest.scenes.find((scene)=>scene.role==="dialogue"); if(!legacy)throw new SourceError("invalid-experience");
    const visualChoices=blueprint.scenes.flatMap((scene)=>scene.cues.flatMap((cue)=>cue.trigger.kind==="choice-applied"?[{visualSceneId:scene.id,visualChoiceId:cue.trigger.choiceId}]:[]));
    const mapping={contract:"ADEENA-VISUAL-SCENE-MAPPING-v1" as const,legacyExperienceId:manifest.manifest.experienceId,scenes:blueprint.scenes.map((scene)=>({visualSceneId:scene.id,legacySceneId:legacy.id})),choices:visualChoices.map((choice)=>({...choice,legacyChoiceId:legacy.choices[0].id}))};
    const context={sceneIds:blueprint.scenes.map((scene)=>scene.id),choiceIdsByScene:Object.fromEntries(blueprint.scenes.map((scene)=>[scene.id,visualChoices.filter((choice)=>choice.visualSceneId===scene.id).map((choice)=>choice.visualChoiceId)])),sourceSpanIds:spans,ageBand:blueprint.ageBand,locale:blueprint.locale,implementedArchetypes:IMPLEMENTED};
    return {blueprint,context,mapping};
  });
  return associateVisualExperience({...input,...prepared,authoredFixture:true,fixtureLabel:"Authored respiratory pathway fixture"});
}
