import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Uuid } from "@/contracts/common";
import { readCreatorPreview } from "@/auth/experiences";
import { creatorWorkflowForPreview } from "@/auth/workflows";
import { CONFIGURED_PROVIDER, FIXTURE_PROVIDER, freeEditAuthorization, selectGenerationProvider } from "@/experience/provider";
import { readVerifiedSession } from "@/auth/session";
import styles from "../../../auth.module.css";
import page from "../../../page.module.css";
import { ExperienceEditor } from "../experience-editor";
import { ExperienceShare } from "../experience-share";
import { ExperiencePreview } from "../experience-preview";

export const metadata: Metadata = { title: "Private preview", robots: { index: false, follow: false } };

const COPY: Record<string, string> = {
  unauthenticated: "Sign in to open this private draft.",
  "cross-workspace": "That experience belongs to another workspace.",
  "invalid-experience": "The generated experience did not pass validation.",
  "invalid-generation": "That experience could not be opened.",
  transient: "The private draft could not be opened.",
};

export default function PreviewPage({ params }: { params: Promise<{ versionId: string }> }) {
  return (
    <Suspense fallback={<main id="content" className={page.main}><p>Checking your session…</p></main>}>
      <PreviewSession params={params} />
    </Suspense>
  );
}

async function PreviewSession({ params }: { params: Promise<{ versionId: string }> }) {
  await connection();
  const { versionId } = await params;
  const session = await readVerifiedSession();
  if (!session) redirect("/login?next=/creator");
  if (!Uuid.safeParse(versionId).success) {
    return <main id="content" className={page.main}><p className={styles.alert} role="alert">{COPY["invalid-generation"]}</p></main>;
  }
  const result = await readCreatorPreview(session.identity, versionId);
  if (!result.ok) {
    const deniedTiming = `workspace=${result.timing.workspaceMs}`;
    return (
      <main id="content" className={page.main}>
        {process.env.ADEENA_PREVIEW_TIMING === "1" ? <div hidden data-preview-timing={deniedTiming} /> : null}
        <p className={styles.alert} role="alert">{COPY[result.error] ?? COPY.transient}</p>
        <p className={page.links}><Link href="/creator">Back to creator</Link></p>
      </main>
    );
  }
  const { preview, history, originalManifest, timing } = result;
  const workflowId = await creatorWorkflowForPreview(session.identity, versionId, preview.parentVersionId);
  const backHref = workflowId ? `/creator/w/${workflowId}` : "/creator";
  const timingLabel = `workspace=${timing.workspaceMs} preview=${timing.previewMs} history=${timing.historyMs} parallel=${timing.parallelMs} original=${timing.originalMs}`;
  const isProposal = preview.edit?.status === "ready" && !preview.isCurrent && Boolean(preview.parentVersionId);
  const notice = [
    "Private draft preview. Publication and source clearance are shown in Share below.",
    "The picture is a simple frame, not a custom animation.",
    preview.provider === FIXTURE_PROVIDER ? "Compiled from the source by the local fixture. This is not a live model result." : "",
    preview.provider === CONFIGURED_PROVIDER ? "A configured model proposed this experience. The server checked the draft. This does not certify it for children or a classroom." : "",
    
    
  ].filter(Boolean).join(" ");
  const currentVersionId = history.find((item) => item.current)?.id ?? null;
  return (
    <>
      {process.env.ADEENA_PREVIEW_TIMING === "1" ? <div hidden data-preview-timing={timingLabel} /> : null}
      <p className={page.links}><Link href={backHref}>{workflowId ? "Back to this experience" : "Back to creator"}</Link></p>
      <ExperienceEditor
        key={isProposal ? "proposal" : preview.isCurrent ? "current" : "kept"}
        versionId={versionId}
        isCurrent={preview.isCurrent}
        isProposal={isProposal}
        discarded={preview.edit?.status === "rejected"}
        editJobId={preview.edit?.jobId ?? null}
        baseVersionId={preview.edit?.baseVersionId ?? null}
        summary={preview.edit?.summary ?? null}
        uncertainty={preview.edit?.uncertainty ?? null}
        reviewNote={preview.edit?.reviewNote ?? null}
        fixture={selectGenerationProvider(process.env) === FIXTURE_PROVIDER}
        configured={selectGenerationProvider(process.env) === CONFIGURED_PROVIDER}
        freeMode={freeEditAuthorization(process.env).ok}
        proposed={preview.manifest}
        original={originalManifest}
        history={history}
        currentVersionId={currentVersionId}
      />
      {isProposal ? null : <ExperiencePreview manifest={preview.manifest} notice={notice} />}
      <ExperienceShare key={versionId} versionId={versionId} />
    </>
  );
}
