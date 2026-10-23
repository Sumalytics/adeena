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
  return (
    <>
      <p className={styles.promise}>Turn content you have permission to use into a private, playable learning game.</p>
      <section className={styles.launch} aria-labelledby="new-experience-heading">
        <p className={styles.eyebrow}>Create something new</p>
        <h2 id="new-experience-heading">Start with your content</h2>
        <p>We’ll guide you through the audience, topic and game creation one step at a time.</p>
        <NewExperience />
      </section>
      <details className={styles.savedWork}>
        <summary>Continue saved work <span>{workflows.length + drafts.length}</span></summary>
        {workflowsUnavailable ? <p className={styles.alert} role="alert">Saved experiences could not be loaded.</p> : null}
        {workflows.length === 0 && drafts.length === 0 && !workflowsUnavailable ? <p className={styles.empty}>Nothing saved yet.</p> : null}
        {workflows.length > 0 ? (
          <section aria-labelledby="experiences-heading">
            <h2 id="experiences-heading">In progress</h2>
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
          </section>
        ) : null}
        {drafts.length > 0 ? (
          <section aria-labelledby="drafts-heading">
          <h2 id="drafts-heading">Private drafts</h2>
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
                <div className={styles.actions}>
                  <Link className={styles.draftLink} href={`/creator/preview/${draft.id}`}>Open private preview</Link>
                </div>
              </li>
            ))}
          </ul>
          </section>
        ) : null}
      </details>
      <details className={styles.disclosure}>
        <summary>How creating works</summary>
        <p>Upload permitted content, choose the audience and topic, then explicitly press Generate. Games stay private until you review and publish them.</p>
      </details>
      <form className={styles.logout} method="post" action="/auth/logout">
        <button className={styles.secondary} type="submit">Log out</button>
      </form>
    </>
  );
}
