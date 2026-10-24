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
import studio from "../creator-studio.module.css";
import { ExperienceActions } from "../experience-actions";
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
  const { preview, visual, history, originalManifest, timing } = result;
  const workflowId = await creatorWorkflowForPreview(session.identity, versionId, preview.parentVersionId);
  const backHref = workflowId ? `/creator/w/${workflowId}` : "/creator";
  const timingLabel = `workspace=${timing.workspaceMs} preview=${timing.previewMs} history=${timing.historyMs} parallel=${timing.parallelMs} original=${timing.originalMs}`;
  const isProposal = preview.edit?.status === "ready" && !preview.isCurrent && Boolean(preview.parentVersionId);
  const notice = "Private draft. Review every path before sharing.";
  const currentVersionId = history.find((item) => item.current)?.id ?? null;
  const selectedProvider = selectGenerationProvider(process.env);
  const status = isProposal ? "Proposed revision" : preview.isCurrent ? "Private draft" : "Earlier private version";
  return (
    <div className={studio.studio}>
      {process.env.ADEENA_PREVIEW_TIMING === "1" ? <div hidden data-preview-timing={timingLabel} /> : null}
      <p className={`${page.links} ${studio.back}`}><Link href={backHref}>{workflowId ? "Back to this experience" : "Back to creator"}</Link></p>
      <header className={studio.heading}><p className={studio.status}>{status}</p></header>
      <section className={studio.playable} aria-label={`${preview.manifest.title} playable preview`}>
        <ExperiencePreview manifest={preview.manifest} notice={notice} visual={visual} />
      </section>
      <ExperienceActions
        key={isProposal ? "proposal" : preview.isCurrent ? "current" : "kept"}
        versionId={versionId}
        editor={{
          versionId,
          isCurrent: preview.isCurrent,
          isProposal,
          discarded: preview.edit?.status === "rejected",
          editJobId: preview.edit?.jobId ?? null,
          baseVersionId: preview.edit?.baseVersionId ?? null,
          summary: preview.edit?.summary ?? null,
          uncertainty: preview.edit?.uncertainty ?? null,
          reviewNote: preview.edit?.reviewNote ?? null,
          fixture: selectedProvider === FIXTURE_PROVIDER,
          configured: selectedProvider === CONFIGURED_PROVIDER,
          freeMode: freeEditAuthorization(process.env).ok,
          proposed: preview.manifest,
          original: originalManifest,
          currentVersionId,
        }}
      />
      <aside className={studio.details} aria-label="Experience details">
        <details>
          <summary>Source details</summary>
          <p>This draft uses selected source excerpts. Source documents and rights evidence remain private.</p>
          <p className={studio.secondaryText}>{preview.provider === FIXTURE_PROVIDER ? "Development fixture: compiled locally without a live AI model." : "A configured model proposed this draft. The server validated and simulated it before preview."}</p>
          <p className={studio.secondaryText}>Version {versionId}</p>
        </details>
        <details>
          <summary>Version history</summary>
          {history.length === 0 ? <p>No revisions yet.</p> : (
            <ul className={studio.history}>
              {history.map((item) => (
                <li key={item.id}>
                  <Link href={`/creator/preview/${item.id}`} aria-current={item.id === versionId ? "page" : undefined}>
                    {item.current ? "Current draft" : item.kind === "original" ? "Original draft" : "Proposed revision"}: {item.title}
                  </Link>
                  {item.summary ? <p className={studio.secondaryText}>{item.summary}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </details>
      </aside>
    </div>
  );
}
