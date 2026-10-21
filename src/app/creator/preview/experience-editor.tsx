"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ExperienceManifest } from "@adeena/experience-schema";
import styles from "../../auth.module.css";
import editorStyles from "./experience-editor.module.css";
import { ExperiencePreview } from "./experience-preview";

type HistoryItem = {
  id: string;
  title: string;
  current: boolean;
  summary: string | null;
  kind: "original" | "revision";
};

const COPY: Record<string, string> = {
  "invalid-edit": "That edit request could not be accepted.",
  "unsupported-edit": "That change is outside the edits this draft can make.",
  "stale-version": "A newer revision is already the current draft.",
  "review-required": "This request needs a person to review it before the draft can change.",
  "invalid-experience": "The revised draft did not pass validation, so the current draft was left unchanged.",
  "generation-unavailable": "AI editing is not configured.",
  "budget-unavailable": "Editing spend is not authorized, so no model call was made.",
  "provider-unavailable": "The model did not answer. The current draft was left unchanged.",
  "job-limit": "This draft already has several proposals waiting. Accept or discard one before proposing another.",
  "cross-workspace": "That experience belongs to another workspace.",
  unauthenticated: "Sign in to edit this private draft.",
  transient: "The edit could not be completed. You can try again.",
};

export function ExperienceEditor({
  versionId,
  isCurrent,
  isProposal,
  discarded,
  editJobId,
  baseVersionId,
  summary,
  uncertainty,
  reviewNote,
  fixture,
  configured,
  freeMode = false,
  proposed,
  original,
  history,
  currentVersionId,
}: {
  versionId: string;
  isCurrent: boolean;
  isProposal: boolean;
  discarded: boolean;
  editJobId: string | null;
  baseVersionId: string | null;
  summary: string | null;
  uncertainty: string | null;
  reviewNote: string | null;
  fixture: boolean;
  configured: boolean;
  freeMode?: boolean;
  proposed: ExperienceManifest;
  original: ExperienceManifest | null;
  history: HistoryItem[];
  currentVersionId: string | null;
}) {
  const router = useRouter();
  const key = useRef<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const [proposalPath, setProposalPath] = useState<string | null>(null);
  const [proposalSummary, setProposalSummary] = useState<string | null>(null);
  const [showing, setShowing] = useState<"proposed" | "original">("proposed");

  async function propose() {
    const idempotencyKey = key.current ?? crypto.randomUUID();
    key.current = idempotencyKey;
    setBusy(true);
    setError("");
    setAlternatives([]);
    setMessage("Preparing a proposal…");
    try {
      const response = await fetch("/api/creator/experiences/edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseVersionId: versionId,
          expectedBaseVersionId: versionId,
          instruction,
          idempotencyKey,
          editPolicyVersion: "1",
          authorizeEdit: true,
        }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; alternatives?: string[]; previewPath?: string; summary?: string } | null;
      if (response.status === 202) {
        setMessage("The proposal is still being prepared. You can try again.");
        return;
      }
      if (!response.ok || !payload || payload.error) {
        const code = payload?.error ?? "transient";
        setError(COPY[code] ?? COPY.transient);
        setAlternatives(Array.isArray(payload?.alternatives) ? payload.alternatives : []);
        setMessage("");
        return;
      }
      setProposalPath(typeof payload.previewPath === "string" ? payload.previewPath : null);
      setProposalSummary(typeof payload.summary === "string" ? payload.summary : null);
      setMessage("A proposal is ready. The current draft stays in place until you accept it.");
    } catch {
      setError(COPY.transient);
      setMessage("");
    } finally {
      setBusy(false);
    }
  }

  async function decide(kind: "accept" | "discard") {
    if (!editJobId || !baseVersionId) return;
    setBusy(true);
    setError("");
    setMessage(kind === "accept" ? "Accepting the revision…" : "Discarding the revision…");
    try {
      const response = await fetch(kind === "accept" ? "/api/creator/experiences/edits/accept" : "/api/creator/experiences/edits/reject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(kind === "accept" ? { editJobId, expectedBaseVersionId: baseVersionId } : { editJobId }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; previewPath?: string } | null;
      if (!response.ok || !payload || payload.error) {
        setError(COPY[payload?.error ?? "transient"] ?? COPY.transient);
        setMessage("");
        return;
      }
      router.push(typeof payload.previewPath === "string" ? payload.previewPath : "/creator");
      router.refresh();
    } catch {
      setError(COPY.transient);
      setMessage("");
    } finally {
      setBusy(false);
    }
  }

  const previewManifest = showing === "original" && original ? original : proposed;
  const previewNotice = showing === "original"
    ? "Original draft. Private and unpublished."
    : "Proposed draft. Private and unpublished until you accept it.";

  return (
    <section className={editorStyles.editor} aria-labelledby="edit-heading">
      <h2 id="edit-heading" className={styles.subhead}>Change this draft</h2>
      {isProposal ? (
        <>
          <p className={styles.note}>{summary}</p>
          {uncertainty ? <p className={styles.note}>{uncertainty}</p> : null}
          {reviewNote ? <p className={styles.note}>{reviewNote} This check does not replace review by a person.</p> : null}
          {original ? (
            <div className={editorStyles.actions} role="group" aria-label="Compare drafts">
              <button className={styles.secondary} type="button" aria-pressed={showing === "original"} onClick={() => setShowing("original")}>Original</button>
              <button className={styles.quiet} type="button" aria-pressed={showing === "proposed"} onClick={() => setShowing("proposed")}>Proposed</button>
            </div>
          ) : null}
          <ExperiencePreview key={`${showing}:${previewManifest.versionId}`} manifest={previewManifest} notice={previewNotice} />
          <div className={editorStyles.actions}>
            <button className={styles.secondary} type="button" disabled={busy} onClick={() => decide("accept")}>Accept changes</button>
            <button className={styles.quiet} type="button" disabled={busy} onClick={() => decide("discard")}>Discard changes</button>
          </div>
        </>
      ) : null}
      {!isCurrent && !isProposal && !discarded ? (
        <p className={styles.note}>
          This revision is kept.
          {currentVersionId ? <> <Link href={`/creator/preview/${currentVersionId}`}>Open the current draft</Link></> : null}
        </p>
      ) : null}
      {discarded ? (
        <p className={styles.note}>
          This proposal was discarded. The current draft was left unchanged.
          {currentVersionId ? <> <Link href={`/creator/preview/${currentVersionId}`}>Open the current draft</Link></> : null}
        </p>
      ) : null}
      {isCurrent ? (
        <form
          className={styles.form}
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void propose();
          }}
        >
          <label htmlFor="edit-instruction">Describe the change</label>
          <textarea
            id="edit-instruction"
            value={instruction}
            maxLength={500}
            required
            onChange={(event) => {
              key.current = null;
              setInstruction(event.target.value);
            }}
          />
          <p className={styles.note}>
            Proposing a change can use AI credits when a live model is configured.
            {fixture ? " This editor is using the local fixture, so this request is not a live model call and is not billed." : ""}
            {freeMode ? " This development server is in free-development mode. A confirmed Free plan is required, and the request is not recorded as paid spend." : ""}
            {configured ? " This server can call the configured model. The result still has to pass the draft checks before you can accept it." : ""}
            {!fixture && !configured ? " AI editing is not configured on this server." : ""}
          </p>
          <button className={styles.secondary} type="submit" disabled={busy}>Propose changes</button>
        </form>
      ) : null}
      {proposalSummary ? <p className={styles.note}>{proposalSummary}</p> : null}
      {proposalPath ? <p className={styles.note}><Link href={proposalPath}>Open the proposed draft</Link></p> : null}
      {message ? <p className={styles.pending} role="status" aria-live="polite">{message}</p> : null}
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
      {alternatives.length > 0 ? (
        <div className={styles.note}>
          <p>You can ask for one of these instead:</p>
          <ul>{alternatives.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : null}
      <nav aria-label="Revision history">
        <h3 className={styles.subhead}>Revision history</h3>
        {history.length === 0 ? <p className={styles.note}>No revisions yet.</p> : (
          <ul>
            {history.map((item) => (
              <li key={item.id}>
                <Link href={`/creator/preview/${item.id}`} aria-current={item.id === versionId ? "page" : undefined}>
                  {item.current ? "Current draft" : item.kind === "original" ? "Original draft" : "Proposed revision"}: {item.title}
                </Link>
                {item.summary ? <p className={styles.note}>{item.summary}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </nav>
    </section>
  );
}
