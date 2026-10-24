import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "postgres";
import { creatorAudioSource } from "@/audio/contract";
import { authorizeTts, conservativeCostMicros, conservativelyMeteredCharacters, type TtsEnvironment } from "@/audio/tts/authorization";
import { narrationCacheKey, normalizeNarrationText } from "@/audio/tts/cache-key";
import { TtsError, type TtsFailureCode } from "@/audio/tts/errors";
import { createNarrationProvider } from "@/audio/tts/providers";
import { VoiceSynthesisRequestV1 } from "@/experience/visual-director/schema";
import { AudioStorageError, type PrivateAudioObjectStore } from "@/storage/audio-object-store";
import { registerPrivateAudioAsset, readPrivateAudioAsset } from "./audio-repository";
import { withWorkspace } from "./authz";
import type { VerifiedIdentity } from "./identity";

const Request = VoiceSynthesisRequestV1.omit({ idempotencyKey: true }).extend({
  experienceVersionId: z.string().uuid(), narrationSegmentId: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  caption: z.string().trim().min(1).max(600), cueIds: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/)).min(1).max(12),
  idempotencyKey: z.string().uuid(), approved: z.literal(true),
}).strict().refine((value) => value.caption === value.text, { message: "Captions must match approved speech.", path: ["caption"] });

export type NarrationGenerationRequest = z.infer<typeof Request>;
type JobRow = {
  id: string; experience_version_id: string; narration_segment_id: string; approved_script: string; locale: string;
  voice_profile_ref: "educator-neutral-1" | "educator-warm-1" | "educator-energetic-1"; voice_style: "calm" | "warm" | "energetic";
  speaking_rate: string | number; cue_ids: unknown; cache_key: string; provider: string; model: string; pricing_version: string;
  output_format: string; attempt_count: number; max_attempts: number; status: string; provider_started_at: Date | null; lease_expires_at: Date | null;
};

export async function enqueueNarrationGeneration(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; request: NarrationGenerationRequest; env?: TtsEnvironment }) {
  const request = Request.parse(input.request);
  const auth = authorizeTts(input.env);
  const normalized = normalizeNarrationText(request.text);
  const characters = conservativelyMeteredCharacters(auth, normalized);
  const estimate = conservativeCostMicros(auth, characters);
  if (estimate > auth.requestCeilingMicros) throw new TtsError("budget-exhausted");
  const cacheKey = narrationCacheKey({ ...request, text: normalized, providerId: auth.providerId, modelId: auth.modelId, outputFormat: auth.outputFormat });
  const scriptHash = createHash("sha256").update(normalized).digest("hex");
  return withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
    const version = await workspace.tx`select id from experience_versions where id=${request.experienceVersionId}::uuid and workspace_id=${input.workspaceId}::uuid`;
    if (!version[0]) throw new TtsError("invalid-input");
    let rows = await workspace.tx<{ id: string; status: string }[]>`
      insert into narration_generation_jobs (
        id,workspace_id,experience_version_id,narration_segment_id,idempotency_key,approved_script,script_hash,approved_by,approved_at,
        locale,voice_profile_ref,voice_style,speaking_rate,cue_ids,cache_key,provider,model,pricing_version,output_format,max_attempts
      ) values (
        ${randomUUID()}::uuid,${input.workspaceId}::uuid,${request.experienceVersionId}::uuid,${request.narrationSegmentId},${request.idempotencyKey}::uuid,
        ${normalized},${scriptHash},${workspace.userId}::uuid,now(),${request.locale},${request.voiceProfileId},${request.style},${request.rate},
        ${JSON.stringify(request.cueIds)}::jsonb,${cacheKey},${auth.providerId},${auth.modelId},${auth.pricingVersion},${auth.outputFormat},1
      ) on conflict (workspace_id,idempotency_key) do nothing returning id::text,status`;
    if (!rows[0]) rows = await workspace.tx<{ id: string; status: string }[]>`select id::text,status from narration_generation_jobs where workspace_id=${input.workspaceId}::uuid and idempotency_key=${request.idempotencyKey}::uuid`;
    return { jobId: rows[0].id, status: rows[0].status, cacheKey };
  });
}

export async function runNarrationGeneration(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; jobId: string; leaseOwner: string; store: PrivateAudioObjectStore; env?: TtsEnvironment; fetchImpl?: typeof fetch; leaseMs?: number }) {
  if (!/^[a-z0-9-]{1,80}$/.test(input.leaseOwner)) throw new TtsError("invalid-input");
  const auth = authorizeTts(input.env);
  const prepared = await prepare(input, auth, input.leaseMs ?? 30_000);
  if (prepared.kind === "done" || prepared.kind === "pending") return prepared;
  if (prepared.kind === "cache") {
    try {
      const source = await readPrivateAudioAsset({ sql: input.sql, identity: input.identity, assetId: prepared.assetId });
      if (!source) throw new TtsError("metadata-failed");
      const bytes = await input.store.read(source.storageLocator);
      const asset = await registerPrivateAudioAsset({ sql: input.sql, identity: input.identity, workspaceId: input.workspaceId,
        experienceVersionId: prepared.job.experience_version_id, narrationSegmentId: prepared.job.narration_segment_id,
        contentHash: source.contentHash, mimeType: source.mimeType, bytes, durationMs: source.durationMs, locale: source.locale,
        voiceProfileRef: source.voiceProfileRef, provenance: source.provenance, store: input.store });
      await finishCacheHit(input, prepared.job, asset.assetId, prepared.playback, source.durationMs, source.byteCount);
      return { kind: "ready" as const, assetId: asset.assetId, source: creatorAudioSource(asset.assetId), playback: { ...prepared.playback, audioAssetId: asset.assetId } };
    } catch (error) { await fail(input, prepared.job, "metadata-failed", false, prepared.estimate); throw error; }
  }
  const provider = createNarrationProvider(auth, input.env, input.fetchImpl);
  let synthesisCompleted = false;
  try {
    const result = await provider.synthesize({ text: prepared.job.approved_script, locale: prepared.job.locale, voiceProfileId: prepared.job.voice_profile_ref,
      style: prepared.job.voice_style, rate: Number(prepared.job.speaking_rate), idempotencyKey: prepared.idempotencyKey });
    synthesisCompleted = true;
    const playback: { contract: string; segmentId: string; audioAssetId: string; durationMs: number; captions: { startMs: number; endMs: number; text: string }[]; cueTimepoints: { cueId: string; atMs: number }[] } = { contract: "ADEENA-NARRATION-PLAYBACK-v1", segmentId: prepared.job.narration_segment_id, audioAssetId: randomUUID(),
      durationMs: result.durationMs, captions: [{ startMs: 0, endMs: result.durationMs, text: prepared.job.approved_script }],
      cueTimepoints: [] };
    const asset = await registerPrivateAudioAsset({ sql: input.sql, identity: input.identity, workspaceId: input.workspaceId,
      experienceVersionId: prepared.job.experience_version_id, narrationSegmentId: prepared.job.narration_segment_id, contentHash: result.checksum,
      mimeType: result.mimeType, bytes: result.bytes, durationMs: result.durationMs, locale: prepared.job.locale,
      voiceProfileRef: prepared.job.voice_profile_ref, provenance: { kind: "voice-provider", providerId: auth.providerId, modelId: auth.modelId, settingsHash: prepared.job.cache_key, cacheKey: prepared.job.cache_key }, store: input.store });
    playback.audioAssetId = asset.assetId;
    await finishMiss(input, prepared.job, asset.assetId, playback, result.durationMs, result.bytes.byteLength, prepared.estimate);
    return { kind: "ready" as const, assetId: asset.assetId, source: creatorAudioSource(asset.assetId), playback };
  } catch (error) {
    const failure = error instanceof TtsError ? error : synthesisCompleted
      ? new TtsError(error instanceof AudioStorageError ? "storage-failed" : "metadata-failed", false, true)
      : new TtsError("provider-network", true);
    await fail(input, prepared.job, failure.code, failure.uncertainCharge, prepared.estimate, failure.knownCharge);
    throw failure;
  }
}

async function prepare(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; jobId: string; leaseOwner: string }, auth: ReturnType<typeof authorizeTts>, leaseMs: number) {
  return withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
    const rows = await workspace.tx<JobRow[]>`select * from narration_generation_jobs where id=${input.jobId}::uuid and workspace_id=${input.workspaceId}::uuid for update`;
    const job = rows[0];
    if (!job || job.provider !== auth.providerId || job.model !== auth.modelId || job.pricing_version !== auth.pricingVersion) throw new TtsError("authorization-required");
    if (job.status === "ready" || job.status === "failed" || job.status === "cancelled") return { kind: "done" as const, status: job.status };
    const leaseExpired = job.lease_expires_at !== null && new Date(job.lease_expires_at).getTime() < Date.now();
    if (job.status === "processing" && !leaseExpired) return { kind: "pending" as const };
    if (job.status === "processing" && leaseExpired && job.provider_started_at) {
      const costs = await workspace.tx<{ estimated_cost_micros: string | number }[]>`select estimated_cost_micros from narration_generation_costs where job_id=${job.id}::uuid order by attempt desc limit 1 for update`;
      const reserved = Number(costs[0]?.estimated_cost_micros ?? 0);
      await workspace.tx`update narration_generation_jobs set status='failed',failure_code='provider-timeout',uncertain_charge=true,lease_owner=null,lease_expires_at=null,completed_at=now(),updated_at=now() where id=${job.id}::uuid`;
      await workspace.tx`update narration_generation_costs set uncertain_charge=true,actual_cost_micros=null,completed_at=now() where job_id=${job.id}::uuid and completed_at is null`;
      await workspace.tx`update narration_development_budgets set reserved_micros=greatest(0,reserved_micros-${reserved}),charged_micros=charged_micros+${reserved},updated_at=now() where workspace_id=${input.workspaceId}::uuid`;
      await workspace.tx`delete from narration_cache_claims where workspace_id=${input.workspaceId}::uuid and cache_key=${job.cache_key} and job_id=${job.id}::uuid`;
      return { kind: "done" as const, status: "failed" };
    }
    const claimed = await workspace.tx<JobRow[]>`update narration_generation_jobs set status='processing',attempt_count=case when status='queued' then attempt_count+1 else attempt_count end,lease_owner=${input.leaseOwner},lease_expires_at=now()+(${leaseMs}*interval '1 millisecond'),updated_at=now() where id=${job.id}::uuid and ((status='queued' and attempt_count < max_attempts) or (status='processing' and lease_expires_at < now() and provider_started_at is null)) returning *`;
    if (!claimed[0]) return { kind: "pending" as const };
    const active = claimed[0];
    const meteredCharacters = conservativelyMeteredCharacters(auth, active.approved_script);
    const estimate = conservativeCostMicros(auth, meteredCharacters);
    const cached = await workspace.tx<{ audio_asset_id: string; playback_metadata: unknown }[]>`select c.audio_asset_id::text,c.playback_metadata from narration_audio_cache c join private_audio_assets a on a.id=c.audio_asset_id and a.status='active' where c.workspace_id=${input.workspaceId}::uuid and c.cache_key=${active.cache_key}`;
    if (cached[0]) {
      await workspace.tx`insert into narration_generation_costs(id,workspace_id,job_id,experience_version_id,narration_segment_id,provider,model,pricing_version,billable_characters,attempt,cache_status,estimated_cost_micros,actual_cost_micros,currency,completed_at) values(${randomUUID()}::uuid,${input.workspaceId}::uuid,${active.id}::uuid,${active.experience_version_id}::uuid,${active.narration_segment_id},${active.provider},${active.model},${active.pricing_version},0,${active.attempt_count},'hit',0,0,'USD',now())`;
      return { kind: "cache" as const, job: active, assetId: cached[0].audio_asset_id, playback: cached[0].playback_metadata as Record<string, unknown>, estimate: 0 };
    }
    const claim = await workspace.tx`insert into narration_cache_claims(workspace_id,cache_key,job_id,lease_expires_at) values(${input.workspaceId}::uuid,${active.cache_key},${active.id}::uuid,now()+(${leaseMs}*interval '1 millisecond')) on conflict do nothing returning job_id`;
    if (!claim[0]) {
      await workspace.tx`update narration_generation_jobs set status='queued',attempt_count=greatest(0,attempt_count-1),lease_owner=null,lease_expires_at=null,updated_at=now() where id=${active.id}::uuid`;
      return { kind: "pending" as const };
    }
    await workspace.tx`insert into narration_development_budgets(workspace_id) values(${input.workspaceId}::uuid) on conflict do nothing`;
    const budget = await workspace.tx<{ reserved_micros: string | number; charged_micros: string | number }[]>`select reserved_micros,charged_micros from narration_development_budgets where workspace_id=${input.workspaceId}::uuid for update`;
    if (estimate > auth.requestCeilingMicros || Number(budget[0].reserved_micros)+Number(budget[0].charged_micros)+estimate > auth.developmentCeilingMicros) {
      await workspace.tx`delete from narration_cache_claims where workspace_id=${input.workspaceId}::uuid and cache_key=${active.cache_key}`;
      await workspace.tx`update narration_generation_jobs set status='failed',failure_code='budget-exhausted',lease_owner=null,lease_expires_at=null,completed_at=now(),updated_at=now() where id=${active.id}::uuid`;
      return { kind: "done" as const, status: "failed" };
    }
    await workspace.tx`update narration_development_budgets set reserved_micros=reserved_micros+${estimate},updated_at=now() where workspace_id=${input.workspaceId}::uuid`;
    await workspace.tx`insert into narration_generation_costs(id,workspace_id,job_id,experience_version_id,narration_segment_id,provider,model,pricing_version,billable_characters,attempt,cache_status,estimated_cost_micros,currency) values(${randomUUID()}::uuid,${input.workspaceId}::uuid,${active.id}::uuid,${active.experience_version_id}::uuid,${active.narration_segment_id},${active.provider},${active.model},${active.pricing_version},${meteredCharacters},${active.attempt_count},'miss',${estimate},'USD')`;
    await workspace.tx`update narration_generation_jobs set provider_started_at=now() where id=${active.id}::uuid and lease_owner=${input.leaseOwner}`;
    await workspace.tx`update narration_cache_claims set provider_started_at=now() where workspace_id=${input.workspaceId}::uuid and cache_key=${active.cache_key} and job_id=${active.id}::uuid`;
    return { kind: "miss" as const, job: active, cueIds: z.array(z.string()).parse(active.cue_ids), estimate, idempotencyKey: randomUUID() };
  });
}

async function finishCacheHit(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; leaseOwner: string }, job: JobRow, assetId: string, playback: Record<string, unknown>, duration: number, bytes: number) {
  await withWorkspace(input.sql,input.identity,input.workspaceId,async({tx})=>{ await tx`update narration_generation_jobs set status='ready',audio_asset_id=${assetId}::uuid,playback_metadata=${JSON.stringify({ ...playback, audioAssetId: assetId })}::jsonb,lease_owner=null,lease_expires_at=null,completed_at=now(),updated_at=now() where id=${job.id}::uuid and lease_owner=${input.leaseOwner}`; await tx`update narration_generation_costs set audio_duration_ms=${duration},audio_bytes=${bytes} where job_id=${job.id}::uuid`; });
}

async function finishMiss(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; leaseOwner: string }, job: JobRow, assetId: string, playback: Record<string, unknown>, duration: number, bytes: number, estimate: number) {
  await withWorkspace(input.sql,input.identity,input.workspaceId,async({tx})=>{
    await tx`insert into narration_audio_cache(workspace_id,cache_key,audio_asset_id,playback_metadata,created_by_job_id) values(${input.workspaceId}::uuid,${job.cache_key},${assetId}::uuid,${JSON.stringify(playback)}::jsonb,${job.id}::uuid) on conflict do nothing`;
    await tx`update narration_generation_jobs set status='ready',audio_asset_id=${assetId}::uuid,playback_metadata=${JSON.stringify(playback)}::jsonb,lease_owner=null,lease_expires_at=null,completed_at=now(),updated_at=now() where id=${job.id}::uuid and lease_owner=${input.leaseOwner}`;
    await tx`update narration_generation_costs set actual_cost_micros=${job.provider === "fake" ? 0 : null},audio_duration_ms=${duration},audio_bytes=${bytes},completed_at=now() where job_id=${job.id}::uuid`;
    await tx`update narration_development_budgets set reserved_micros=greatest(0,reserved_micros-${estimate}),charged_micros=charged_micros+${estimate},updated_at=now() where workspace_id=${input.workspaceId}::uuid`;
    await tx`delete from narration_cache_claims where workspace_id=${input.workspaceId}::uuid and cache_key=${job.cache_key} and job_id=${job.id}::uuid`;
  });
}

async function fail(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; leaseOwner: string }, job: JobRow, code: TtsFailureCode, uncertain: boolean, estimate: number, knownCharge = false) {
  await withWorkspace(input.sql,input.identity,input.workspaceId,async({tx})=>{
    await tx`update narration_generation_jobs set status='failed',failure_code=${code},uncertain_charge=${uncertain},lease_owner=null,lease_expires_at=null,completed_at=now(),updated_at=now() where id=${job.id}::uuid and lease_owner=${input.leaseOwner}`;
    await tx`update narration_generation_costs set actual_cost_micros=${uncertain ? null : knownCharge ? estimate : 0},uncertain_charge=${uncertain},completed_at=now() where job_id=${job.id}::uuid`;
    await tx`update narration_development_budgets set reserved_micros=greatest(0,reserved_micros-${estimate}),charged_micros=charged_micros+${uncertain || knownCharge ? estimate : 0},updated_at=now() where workspace_id=${input.workspaceId}::uuid`;
    await tx`delete from narration_cache_claims where workspace_id=${input.workspaceId}::uuid and cache_key=${job.cache_key} and job_id=${job.id}::uuid`;
  });
}

export async function cancelNarrationGeneration(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; jobId: string }) {
  return withWorkspace(input.sql,input.identity,input.workspaceId,async({tx}) => (await tx`update narration_generation_jobs set status='cancelled',failure_code=null,completed_at=now(),updated_at=now() where id=${input.jobId}::uuid and workspace_id=${input.workspaceId}::uuid and status='queued' returning id`).length === 1);
}
