"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ExperienceManifest } from "@adeena/experience-schema";
import styles from "../../auth.module.css";
import editorStyles from "./experience-editor.module.css";
import { ExperiencePreview } from "./experience-preview";

const COPY: Record<string, string> = {
  "invalid-edit": "That edit request could not be accepted.",
  "unsupported-edit": "That change is outside this editor. Try shortening the language, clarifying consequences, rewording choices or adding one decision.",
  "stale-version": "A newer revision is already the current draft.",
  "review-required": "This change involves high-risk material and cannot be made in this workflow. Keep the current draft or request a different ordinary-content change.",
  "invalid-experience": "The revised draft did not pass validation, so the current draft was left unchanged.",
  "generation-unavailable": "AI editing is not configured.",
  "budget-unavailable": "Editing spend is not authorized, so no model call was made.",
  "provider-unavailable": "The model did not answer. The current draft was left unchanged.",
  "job-limit": "This draft already has several proposals waiting. Accept or discard one before proposing another.",
  "cross-workspace": "That experience belongs to another workspace.",
  unauthenticated: "Sign in to edit this private draft.",
  transient: "The edit could not be completed. You can try again.",
};

const FIXTURE_EDITS = [
  { label: "Shorten the introduction", instruction: "Shorten the introduction but keep the learning objective." },
  { label: "Simplify the dialogue", instruction: "Simplify the dialogue." },
  { label: "Clarify wrong-choice feedback", instruction: "Explain a wrong choice before the draft ends." },
  { label: "Reword the choices", instruction: "Reword the choices." },
] as const;

export type ExperienceEditorProps = {
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
  currentVersionId: string | null;
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
  currentVersionId,
}: ExperienceEditorProps) {
  const router = useRouter();
  const key = useRef<{ instruction: string; value: string } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const [proposalPath, setProposalPath] = useState<string | null>(null);
  const [proposalSummary, setProposalSummary] = useState<string | null>(null);
  const [showing, setShowing] = useState<"proposed" | "original">("proposed");

  async function propose(requestedInstruction = instruction) {
    const idempotencyKey = key.current?.instruction === requestedInstruction ? key.current.value : crypto.randomUUID();
    key.current = { instruction: requestedInstruction, value: idempotencyKey };
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
          instruction: requestedInstruction,
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
      {isCurrent && fixture ? (
        <div className={styles.form} aria-busy={busy}>
          <h3>Choose a supported quick edit</h3>
          <p className={styles.note}>The development fixture can make only these bounded changes. It does not call a live AI model.</p>
          <div className={editorStyles.quickEdits}>
            {FIXTURE_EDITS.map((edit) => (
              <button key={edit.instruction} className={styles.secondary} type="button" disabled={busy} onClick={() => void propose(edit.instruction)}>
                {edit.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {isCurrent && configured ? (
        <form
          className={styles.form}
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void propose();
          }}
        >
          <label htmlFor="edit-instruction">Describe a bounded change</label>
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
            You can shorten or simplify language, clarify consequences, reword choices or add one decision. Source facts, the learning objective, publishing and executable content cannot be changed here. Proposing a change can use AI credits.
            {freeMode ? " This development server is in free-development mode. A confirmed Free plan is required, and the request is not recorded as paid spend." : ""}
            {" The result must pass draft checks before you can accept it."}
          </p>
          <button className={styles.secondary} type="submit" disabled={busy}>Propose changes</button>
        </form>
      ) : null}
      {isCurrent && !fixture && !configured ? <p className={styles.note}>Editing is not configured on this server.</p> : null}
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
    </section>
  );
}
