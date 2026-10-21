import { redirect } from "next/navigation";
import Link from "next/link";
import { openIndividualWorkspace } from "@/auth/home";
import { readVerifiedSession } from "@/auth/session";
import { listCreatorDrafts } from "@/auth/experiences";
import { listCreatorSources } from "@/auth/topics";
import styles from "../auth.module.css";
import page from "../page.module.css";
import { TopicExplorer } from "./topic-explorer";
import { SourceUpload } from "./source-upload";

export async function CreatorSession() {
  const session = await readVerifiedSession();
  if (!session) redirect("/login?next=/creator");
  let workspaceId: string;
  try {
    const workspace = await openIndividualWorkspace(session.identity);
    workspaceId = workspace.workspaceId;
  } catch {
    return (
      <p className={styles.alert} role="alert">
        Your workspace could not be opened.
      </p>
    );
  }
  let sources: Awaited<ReturnType<typeof listCreatorSources>> = [];
  let drafts: Awaited<ReturnType<typeof listCreatorDrafts>> = [];
  try {
    sources = await listCreatorSources(session.identity, workspaceId);
    drafts = await listCreatorDrafts(session.identity, workspaceId);
  } catch {
    sources = [];
    drafts = [];
  }
  return (
    <>
      <ol className={styles.steps}>
        <li>Choose / Upload</li>
        <li>Generate</li>
        <li>Preview</li>
        <li>Share</li>
      </ol>
      <p className={page.lead}>Your personal workspace is ready. The studio preview still uses the sample path.</p>
      <p className={styles.note}>Topic recommendation runs only on a source already extracted in this workspace. It looks at headings and short excerpts, which is not a safety review, and it does not generate a game.</p>
      <SourceUpload sources={sources} />
      {sources.some((source) => source.extractionStatus === "complete" || source.extractionStatus === "partial") ? (
        <TopicExplorer sources={sources.filter((source) => source.extractionStatus === "complete" || source.extractionStatus === "partial")} />
      ) : null}
      <section aria-labelledby="draft-heading">
        <h2 id="draft-heading" className={styles.subhead}>Private drafts</h2>
        {drafts.length === 0 ? <p className={styles.note}>No private experience draft yet.</p> : (
          <ul>
            {drafts.map((draft) => (
              <li key={draft.id}>
                <Link href={`/creator/preview/${draft.id}`}>{draft.title}</Link>
                <p className={styles.note}>
                  {draft.reviewStatus === "review-required" ? "Needs review. " : ""}
                  Unpublished. The local fixture compiled this from the source. It is not a live model result. Open it to ask for a change. The original stays until you accept a proposal.
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className={page.links}>
        <Link className={page.enter} href="/studio">
          Continue in Creator Studio
        </Link>
      </p>
      <form action="/auth/logout" method="post">
        <button className={styles.secondary} type="submit">
          Log out
        </button>
      </form>
    </>
  );
}
