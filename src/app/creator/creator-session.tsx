import { connection } from "next/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { openIndividualWorkspace } from "@/auth/home";
import { readVerifiedSession } from "@/auth/session";
import { listCreatorDrafts } from "@/auth/experiences";
import { listCreatorSources } from "@/auth/topics";
import { listCreatorWorkflowRecords } from "@/auth/workflows";
import styles from "./creator.module.css";
import { NewExperience } from "./new-experience";

export async function CreatorSession() {
  await connection();
  const session = await readVerifiedSession();
  if (!session) redirect("/login?next=/creator");
  let workspaceId: string;
  try {
    const workspace = await openIndividualWorkspace(session.identity);
    workspaceId = workspace.workspaceId;
  } catch {
    return <p className={styles.alert} role="alert">Your workspace could not be opened.</p>;
  }
  let sources: Awaited<ReturnType<typeof listCreatorSources>> = [];
  let drafts: Awaited<ReturnType<typeof listCreatorDrafts>> = [];
  let workflows: Awaited<ReturnType<typeof listCreatorWorkflowRecords>> = [];
  let workflowsUnavailable = false;
  try {
    sources = await listCreatorSources(session.identity, workspaceId);
    drafts = await listCreatorDrafts(session.identity, workspaceId);
  } catch {
    sources = [];
    drafts = [];
  }
  try {
    workflows = await listCreatorWorkflowRecords(session.identity, workspaceId);
  } catch {
    workflowsUnavailable = true;
  }
  const current = workflows.length === 0 ? "choose" : drafts.length === 0 ? "generate" : "preview";

  return (
    <>
      <p className={styles.promise}>
        Start with a source you have permission to use. Adeena stores it privately, then helps you choose a topic.
      </p>
      <ol className={styles.steps} aria-label="Creation steps">
        <li className={styles.step} aria-current={current === "choose" ? "step" : undefined}>
          <small>1</small>
          <strong>Choose</strong>
        </li>
        <li className={styles.step} aria-current={current === "generate" ? "step" : undefined}>
          <small>2</small>
          <strong>Generate</strong>
        </li>
        <li className={styles.step} aria-current={current === "preview" ? "step" : undefined}>
          <small>3</small>
          <strong>Preview</strong>
        </li>
        <li className={styles.step}>
          <small>4</small>
          <strong>Share</strong>
          <small>In private preview</small>
        </li>
      </ol>
      <p className={styles.shareNote}>Open a private preview to review, approve and share an eligible version. Draft edits stay private.</p>
      <section className={styles.stage} aria-labelledby="experiences-heading">
        <div className={styles.stageHeader}>
          <h2 id="experiences-heading">Your experiences</h2>
          <p className={styles.quiet}>Start a new experience, or continue one you already saved.</p>
        </div>
        <NewExperience />
        {workflowsUnavailable ? <p className={styles.alert} role="alert">Saved experiences could not be loaded.</p> : null}
        {workflows.length === 0 && !workflowsUnavailable ? <p className={styles.empty}>No saved experience yet.</p> : null}
        {workflows.length > 0 ? (
          <ul className={styles.cards}>
            {workflows.map((workflow) => {
              const source = sources.find((item) => item.documentVersionId === workflow.documentVersionId);
              const detail = [workflow.audienceLabel, workflow.ageBand, workflow.selectedTopicCandidateId ? "Topic saved" : null].filter(Boolean).join(" · ");
              return (
                <li className={styles.card} key={workflow.id}>
                  <h3>{source?.filename ?? "New experience"}</h3>
                  <p className={styles.meta}>{detail || "No source saved yet"}</p>
                  <div className={styles.actions}>
                    <Link className={styles.draftLink} href={`/creator/w/${workflow.id}`}>Continue</Link>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
      <section className={styles.stage} aria-labelledby="drafts-heading">
        <div className={styles.stageHeader}>
          <h2 id="drafts-heading">Private drafts</h2>
          <p className={styles.quiet}>Only you can open these. Nothing here is public.</p>
        </div>
        {drafts.length === 0 ? <p className={styles.empty}>No private draft yet.</p> : (
          <ul className={styles.cards}>
            {drafts.map((draft) => (
              <li className={styles.card} key={draft.id}>
                <p className={`${styles.status} ${styles.private}`}>Private</p>
                <h3>{draft.title}</h3>
                <p className={styles.meta}>
                  {draft.reviewStatus === "review-required" ? "Needs review" : "Ready for review"}
                  {" · "}
                  Unpublished
                </p>
                <p className={styles.help}>
                  {draft.liveModel ? "A configured AI model planned this from your selected source. Review the content and all outcomes." : "The local fixture compiled this from the source. It is not a live model result."}
                  Open it to ask for a change. The original stays until you accept a proposal.
                </p>
                <div className={styles.actions}>
                  <Link className={styles.draftLink} href={`/creator/preview/${draft.id}`}>Open private preview</Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <form className={styles.logout} method="post" action="/auth/logout">
        <button className={styles.secondary} type="submit">Log out</button>
      </form>
    </>
  );
}
