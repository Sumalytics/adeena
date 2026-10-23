import { CONFIGURED_PROVIDER, selectGenerationProvider } from "@/experience/provider";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AUDIENCE_OPTIONS } from "@/app/studio/studio-form";
import { creatorDatabase } from "@/auth/database";
import { readVerifiedSession } from "@/auth/session";
import { openIndividualWorkspace } from "@/auth/home";
import { listCreatorSources, readCreatorTopic } from "@/auth/topics";
import { creatorWorkflowGenerationReadResponse, readCreatorWorkflowRecord } from "@/auth/workflows";
import { AgeBand } from "@/contracts/common";
import type { WorkflowGenerationState } from "../../workflow-state";
import type { TopicRecommendationView } from "@/topic/public";
import styles from "../../creator.module.css";
import { WorkflowEditor } from "../../workflow-editor";

export async function WorkflowSession({ params }: { params: Promise<{ workflowId: string }> }) {
  await connection();
  const { workflowId } = await params;
  const session = await readVerifiedSession();
  if (!session) redirect(`/login?next=/creator/w/${workflowId}`);
  let workspaceId: string;
  try {
    workspaceId = (await openIndividualWorkspace(session.identity)).workspaceId;
  } catch {
    return <p className={styles.alert} role="alert">Your workspace could not be opened.</p>;
  }
  const workflow = await readCreatorWorkflowRecord(session.identity, workspaceId, workflowId);
  if (!workflow) return <p className={styles.alert} role="alert">That experience could not be opened.</p>;
  const sources = await listCreatorSources(session.identity, workspaceId);
  const age = AgeBand.safeParse(workflow.ageBand);
  const audience = AUDIENCE_OPTIONS.find((option) => option === workflow.audienceLabel);
  let recommendation: TopicRecommendationView | null = null;
  if (workflow.documentVersionId && audience && age.success) {
    try {
      recommendation = await readCreatorTopic(session.identity, workspaceId, {
        documentVersionId: workflow.documentVersionId,
        audienceLabel: audience,
        ageBand: age.data,
      });
    } catch {
      recommendation = null;
    }
  }
  let generation: WorkflowGenerationState | null = null;
  if (workflow.generationJobId || workflow.generationIdempotencyKey) {
    const read = await creatorWorkflowGenerationReadResponse({ session, sql: creatorDatabase(), workflowId });
    if (read.status === 200 && read.body.generation) {
      generation = {
        jobId: read.body.generation.jobId,
        status: read.body.generation.status,
        experienceVersionId: read.body.generation.experienceVersionId,
        failureCode: read.body.generation.failureCode,
        previewPath: read.body.generation.previewPath,
        liveModel: read.body.generation.liveModel,
      };
    }
  }
  return <WorkflowEditor workflow={workflow} sources={sources} recommendation={recommendation} generation={generation} liveGeneration={selectGenerationProvider(process.env) === CONFIGURED_PROVIDER} />;
}
