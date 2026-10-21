import { redirect } from "next/navigation";
import Link from "next/link";
import { openIndividualWorkspace } from "@/auth/home";
import { readVerifiedSession } from "@/auth/session";
import { listCreatorSources } from "@/auth/topics";
import styles from "../auth.module.css";
import page from "../page.module.css";
import { TopicExplorer } from "./topic-explorer";

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
  try {
    sources = await listCreatorSources(session.identity, workspaceId);
  } catch {
    sources = [];
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
      <p className={styles.note}>Files stay on this device. Private upload is not available yet.</p>
      <p className={styles.note}>Topic recommendation runs only on a source already extracted in this workspace. It does not generate a game.</p>
      {sources.length > 0 ? <TopicExplorer sources={sources} /> : null}
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
