import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { parseManifest } from "@adeena/experience-schema";
import { Uuid } from "@/contracts/common";
import { SourceError } from "@/source/errors";
import {
  billedMicros,
  configuredEditAuthorization,
  GENERATION_LIMITS,
  GROQ_COMMERCIAL_SCHEDULE,
  type ProviderEnv,
  type RateSchedule,
} from "@/experience/provider";
import {
  VISUAL_PLAN_PROMPT_VERSION,
  VISUAL_REVIEW_PROMPT_VERSION,
  selectedVisualSource,
  type VisualDirectorInput,
} from "@/experience/visual-director/model-plan";
import { ARCHETYPE_REGISTRY } from "@/experience/visual-director/schema";
import { withWorkspace } from "./authz";
import type { VerifiedIdentity } from "./identity";

type Options = { env?: ProviderEnv; fetchImpl?: typeof fetch; schedules?: Record<string, RateSchedule> };
export type VisualGenerationResult = {
  jobId: string;
  status: "ready" | "unsupported-visual-treatment" | "rejected" | "in-progress";
  associationId?: string;
  reason?: string;
  diagnostics?: { code: string; message: string }[];
  usage?: { callCount: number; inputTokens: number; outputTokens: number; actualCostMicros: number | null; commercialEstimateMicros: number | null; durationMs: number | null };
  replayed: boolean;
};
export type VisualGenerationView = VisualGenerationResult & {
  internalStatus: "queued" | "planning" | "reviewing" | "ready" | "unsupported" | "failed";
};

const implemented = Object.entries(ARCHETYPE_REGISTRY).filter(([, value]) => value.renderer === "implemented").map(([id]) => id) as VisualDirectorInput["implementedArchetypes"];
type JobRow = { id: string; status: string; association_id: string | null; failure_code: string | null; diagnostics: unknown; duration_ms: number | null };

export async function loadVisualDirectorInputInScope(tx: Sql, workspaceId: string, experienceVersionId: string): Promise<VisualDirectorInput> {
    const rows = await tx<{ manifest: unknown; document_version_id: string; topic_title: string; audience_label: string; age_band: VisualDirectorInput["source"]["ageBand"]; source_span_ids: unknown; learner_objective: string | null }[]>`
      with recursive lineage as (
        select v0.id,v0.parent_version_id,v0.job_id,0 as depth from experience_versions v0
        where v0.id=${experienceVersionId}::uuid and v0.workspace_id=${workspaceId}::uuid
        union all
        select parent.id,parent.parent_version_id,parent.job_id,lineage.depth+1 from experience_versions parent
        join lineage on lineage.parent_version_id=parent.id where parent.workspace_id=${workspaceId}::uuid and lineage.depth<20
      ), origin as (select id,job_id from lineage where job_id is not null order by depth desc limit 1)
      select v.manifest,v.document_version_id::text,c.title as topic_title,j.audience_label,j.age_band,v.source_span_ids,
        p.plan->>'learnerObjective' as learner_objective
      from experience_versions v
      join origin o on true
      join experience_generation_jobs j on j.id=o.job_id and j.workspace_id=v.workspace_id
      join topic_candidates c on c.id=v.topic_candidate_id and c.workspace_id=v.workspace_id
      join source_document_versions d on d.id=v.document_version_id and d.workspace_id=v.workspace_id
      left join experience_plans p on p.experience_version_id=o.id and p.workspace_id=v.workspace_id
      where v.id=${experienceVersionId}::uuid and v.workspace_id=${workspaceId}::uuid and v.publication_status='unpublished' and d.rights_status<>'blocked'`;
    const row = rows[0];
    const manifest = parseManifest(row?.manifest);
    if (!row || !manifest.ok) throw new SourceError("invalid-experience");
    const wanted = Array.isArray(row.source_span_ids) ? row.source_span_ids.filter((id): id is string => typeof id === "string") : [];
    const spans = await tx<{ id: string; excerpt: string }[]>`select id::text,coalesce(generation_excerpt,excerpt) as excerpt from source_spans where workspace_id=${workspaceId}::uuid and document_version_id=${row.document_version_id}::uuid and id::text in ${tx(wanted)}`;
    if (!wanted.length || spans.length !== wanted.length) throw new SourceError("invalid-experience");
    const source = selectedVisualSource({ documentVersionId: row.document_version_id, topicTitle: row.topic_title, audienceLabel: row.audience_label, ageBand: row.age_band, spans, experienceId: manifest.manifest.experienceId, versionId: manifest.manifest.versionId });
    if (!source.spans.length) throw new SourceError("insufficient-source");
    return { source, learningObjective: row.learner_objective ?? `Explain and apply ${row.topic_title}.`, locale: manifest.manifest.locale, manifest: manifest.manifest, implementedArchetypes: implemented, allowedAssetIds: manifest.manifest.assets.map((asset) => asset.id), practiceMechanics: ["sequence-steps", "classify", "calculate-two-set-cardinality"] };
}

async function loadInput(sql: Sql, identity: VerifiedIdentity, workspaceId: string, experienceVersionId: string): Promise<VisualDirectorInput> {
  return withWorkspace(sql, identity, workspaceId, ({ tx }) => loadVisualDirectorInputInScope(tx, workspaceId, experienceVersionId));
}

export async function enqueueVisualGeneration(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; experienceVersionId: string; idempotencyKey: string } & Pick<Options, "env" | "schedules">): Promise<VisualGenerationView> {
  if (!Uuid.safeParse(input.experienceVersionId).success || !Uuid.safeParse(input.idempotencyKey).success) throw new SourceError("invalid-generation");
  const env = input.env ?? process.env;
  const auth = configuredEditAuthorization(env, input.schedules);
  if (!auth.ok) throw new SourceError(auth.code);
  const free = "mode" in auth;
  const schedule = free ? GROQ_COMMERCIAL_SCHEDULE : auth.spend;
  const ceiling = ([GENERATION_LIMITS.visualPlan, GENERATION_LIMITS.visualReview] as const).reduce((sum, limit) => sum + (billedMicros(schedule, limit.input, 0, limit.output) ?? 2_000_000_000), 0);
  await loadInput(input.sql, input.identity, input.workspaceId, input.experienceVersionId);
  return withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
    const association = await workspace.tx<{ id: string; authored_fixture: boolean }[]>`select id::text,authored_fixture from visual_experience_blueprints where workspace_id=${input.workspaceId}::uuid and experience_version_id=${input.experienceVersionId}::uuid`;
    if (association[0]?.authored_fixture) throw new SourceError("invalid-experience");
    const created = randomUUID();
    await workspace.tx`insert into visual_generation_jobs(id,workspace_id,experience_version_id,idempotency_key,provider,status,prompt_version,review_prompt_version,created_by)
      values(${created}::uuid,${input.workspaceId}::uuid,${input.experienceVersionId}::uuid,${input.idempotencyKey}::uuid,'configured-provider','queued',${VISUAL_PLAN_PROMPT_VERSION},${VISUAL_REVIEW_PROMPT_VERSION},${workspace.userId}::uuid)
      on conflict do nothing`;
    const rows = await workspace.tx<JobRow[]>`select id::text,status,association_id::text,failure_code,diagnostics,duration_ms from visual_generation_jobs where workspace_id=${input.workspaceId}::uuid and experience_version_id=${input.experienceVersionId}::uuid`;
    const job = rows[0];
    if (!job) throw new SourceError("invalid-generation");
    if (association[0]) return { ...present(job, true), status: "ready", associationId: association[0].id, internalStatus: "ready" };
    if (!free && ceiling > auth.spend.maxEditMicros && job.status === "queued") {
      const diagnostics = [{ code: "budget-unavailable", message: "The authorized per-generation limit does not cover the bounded visual-generation operation." }];
      await workspace.tx`update visual_generation_jobs set status='failed',failure_code='budget-unavailable',diagnostics=${JSON.stringify(diagnostics)}::jsonb,updated_at=now() where id=${job.id}::uuid`;
      return { ...present({ ...job, status: "failed", failure_code: "budget-unavailable", diagnostics }, job.id !== created), internalStatus: "failed" };
    }
    return { ...present(job, job.id !== created), internalStatus: asInternalStatus(job.status) };
  });
}

export async function readVisualGeneration(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; experienceVersionId: string }): Promise<VisualGenerationView | null> {
  if (!Uuid.safeParse(input.experienceVersionId).success) throw new SourceError("invalid-generation");
  return withWorkspace(input.sql, input.identity, input.workspaceId, async ({ tx }) => {
    const rows = await tx<JobRow[]>`select id::text,status,association_id::text,failure_code,diagnostics,duration_ms from visual_generation_jobs where workspace_id=${input.workspaceId}::uuid and experience_version_id=${input.experienceVersionId}::uuid`;
    const job = rows[0];
    return job ? { ...present(job, true), internalStatus: asInternalStatus(job.status) } : null;
  });
}

function present(job: { id: string; status: string; association_id: string | null; failure_code: string | null; diagnostics: unknown; duration_ms: number | null }, replayed: boolean): VisualGenerationResult {
  const status = job.status === "ready" ? "ready" : job.status === "unsupported" ? "unsupported-visual-treatment" : job.status === "failed" ? "rejected" : "in-progress";
  const diagnostics = Array.isArray(job.diagnostics) ? job.diagnostics.flatMap((item) => item && typeof item === "object" && "code" in item && "message" in item ? [{ code: String(item.code), message: String(item.message) }] : []) : undefined;
  return { jobId: job.id, status, associationId: job.association_id ?? undefined, reason: job.failure_code ?? undefined, diagnostics, replayed };
}

function asInternalStatus(status: string): VisualGenerationView["internalStatus"] {
  return status === "queued" || status === "planning" || status === "reviewing" || status === "ready" || status === "unsupported" ? status : "failed";
}
