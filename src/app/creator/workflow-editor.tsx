"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AUDIENCE_OPTIONS } from "@/app/studio/studio-form";
import type { ExtractedSourceSummary, TopicRecommendationView } from "@/topic/public";
import styles from "./creator.module.css";
import { SourceUpload } from "./source-upload";
import {
  generationFailureCopy,
  generationStatusCopy,
  topicSavePlan,
  workflowUpdateFailure,
  type CreatorWorkflowView,
  type WorkflowGenerationState,
} from "./workflow-state";

const AGE_BANDS = [
  ["5-7", "Ages 5–7"],
  ["8-10", "Ages 8–10"],
  ["11-13", "Ages 11–13"],
  ["14-18", "Ages 14–18"],
  ["adult", "Adult"],
  ["unspecified", "Unspecified"],
] as const;

export function WorkflowEditor({
  workflow,
  sources,
  recommendation,
  generation,
}: {
  workflow: CreatorWorkflowView;
  sources: ExtractedSourceSummary[];
  recommendation: TopicRecommendationView | null;
  generation?: WorkflowGenerationState | null;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(workflow);
  const [sourceChoice, setSourceChoice] = useState(workflow.documentVersionId);
  const [audience, setAudience] = useState(workflow.audienceLabel ?? "");
  const [age, setAge] = useState(workflow.ageBand ?? "");
  const [topicView, setTopicView] = useState(recommendation);
  const [topicChoice, setTopicChoice] = useState(workflow.selectedTopicCandidateId);
  const [draft, setDraft] = useState(generation ?? null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);

  const sourceReady = Boolean(current.documentVersionId);
  const audienceReady = Boolean(current.audienceLabel && current.ageBand);
  const topicReady = Boolean(current.selectedTopicCandidateId);
  const sourceDirty = sourceChoice !== current.documentVersionId;
  const audienceDirty = audience !== (current.audienceLabel ?? "") || age !== (current.ageBand ?? "");
  const plan = topicSavePlan(topicView);
  const previewId = current.experienceVersionId ?? (draft?.status === "ready" ? draft.experienceVersionId : null);
  const generationRunning = Boolean(draft && draft.status !== "ready" && draft.status !== "failed" && draft.status !== "cancelled");
  const canSaveSource = Boolean(sourceChoice) && (!sourceReady || sourceDirty);
  const primary = canSaveSource
    ? "source"
    : !sourceReady
      ? "none"
      : !audienceReady || audienceDirty
        ? "audience"
        : !topicReady && plan === "choose"
          ? "topic"
        : !topicReady
          ? "recommend"
          : previewId || draft?.status === "failed"
            ? "none"
            : generationRunning
              ? "continue"
              : "generate";
  const step = previewId ? "preview" : topicReady ? "generate" : "choose";
  const selectedCandidate = topicView?.candidates.find((candidate) => candidate.id === current.selectedTopicCandidateId);
  const selectedTitle = selectedCandidate?.title
    ?? (topicView?.recommendation?.topicCandidateId === current.selectedTopicCandidateId ? topicView.recommendation.topicTitle : null);
  const syncKey = `${workflow.version}:${recommendation?.recommendation?.id ?? ""}:${generation?.jobId ?? ""}:${generation?.status ?? ""}`;
  const [seenSync, setSeenSync] = useState(syncKey);
  if (seenSync !== syncKey) {
    setSeenSync(syncKey);
    setCurrent(workflow);
    setSourceChoice(workflow.documentVersionId);
    setAudience(workflow.audienceLabel ?? "");
    setAge(workflow.ageBand ?? "");
    setTopicChoice(workflow.selectedTopicCandidateId);
    setTopicView(recommendation);
    setDraft(generation ?? null);
    setStale(false);
  }

  function applyWorkflow(next: CreatorWorkflowView) {
    setCurrent(next);
    setSourceChoice(next.documentVersionId);
    setAudience(next.audienceLabel ?? "");
    setAge(next.ageBand ?? "");
    setTopicChoice(next.selectedTopicCandidateId);
    if (next.documentVersionId !== current.documentVersionId || next.audienceLabel !== current.audienceLabel || next.ageBand !== current.ageBand) {
      setTopicView(null);
    }
  }

  async function save(body: Record<string, unknown>) {
    setPending(true);
    setError("");
    setSaved("");
    try {
      const response = await fetch(`/api/creator/workflows/${current.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, expectedVersion: current.version }),
      });
      const payload = (await response.json()) as CreatorWorkflowView & { error?: string };
      if (!response.ok) {
        const failure = workflowUpdateFailure(response.status);
        setStale(failure.stale);
        setError(failure.message);
        return null;
      }
      applyWorkflow(payload);
      setStale(false);
      setSaved("Progress saved");
      router.refresh();
      return payload;
    } catch {
      setError("That change did not reach the workspace.");
      return null;
    } finally {
      setPending(false);
    }
  }

  async function reload() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/creator/workflows/${current.id}`);
      const payload = (await response.json()) as CreatorWorkflowView & { error?: string };
      if (!response.ok) {
        setError("The saved experience could not be reloaded.");
        return;
      }
      applyWorkflow(payload);
      setTopicView(null);
      setStale(false);
      setSaved("");
      router.refresh();
    } catch {
      setError("The saved experience could not be reloaded.");
    } finally {
      setPending(false);
    }
  }

  async function recommend() {
    if (!current.documentVersionId || !current.audienceLabel || !current.ageBand) return;
    setPending(true);
    setError("");
    setSaved("");
    try {
      const response = await fetch("/api/creator/topics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          documentVersionId: current.documentVersionId,
          audienceLabel: current.audienceLabel,
          ageBand: current.ageBand,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const view = (await response.json()) as TopicRecommendationView & { error?: string };
      if (!response.ok) {
        setError("The topic recommendation could not be prepared.");
        return;
      }
      setTopicView(view);
      if (topicSavePlan(view) !== "resolve") {
        router.refresh();
        return;
      }
      const resolved = await fetch(`/api/creator/workflows/${current.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: current.version, resolveRecommendedTopic: true }),
      });
      const payload = (await resolved.json()) as CreatorWorkflowView & { error?: string };
      if (!resolved.ok) {
        const failure = workflowUpdateFailure(resolved.status);
        setStale(failure.stale);
        setError(failure.message);
        return;
      }
      applyWorkflow(payload);
      setSaved("Progress saved");
      router.refresh();
    } catch {
      setError("The topic recommendation did not reach the workspace.");
    } finally {
      setPending(false);
    }
  }

  async function generateDraft() {
    setPending(true);
    setError("");
    setSaved("");
    try {
      const response = await fetch(`/api/creator/workflows/${current.id}/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: current.version, authorizeGeneration: true }),
      });
      const payload = (await response.json()) as {
        error?: string;
        workflow?: CreatorWorkflowView;
        generation?: WorkflowGenerationState;
      };
      if (payload.workflow) applyWorkflow(payload.workflow);
      if (payload.generation) setDraft(payload.generation);
      if (!response.ok) {
        const failure = workflowUpdateFailure(response.status);
        setStale(failure.stale);
        setError(failure.stale ? failure.message : generationFailureCopy(payload.generation?.failureCode ?? payload.error));
        return;
      }
      setStale(false);
      router.refresh();
    } catch {
      setError("That experience did not reach the workspace.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <p className={styles.promise}>Continue this experience. Each saved choice stays with it.</p>
      <ol className={styles.steps} aria-label="Creation steps">
        <li className={styles.step} aria-current={step === "choose" ? "step" : undefined}><small>1</small><strong>Choose</strong></li>
        <li className={styles.step} aria-current={step === "generate" ? "step" : undefined}><small>2</small><strong>Generate</strong></li>
        <li className={styles.step} aria-current={step === "preview" ? "step" : undefined}><small>3</small><strong>Preview</strong></li>
        <li className={styles.step}><small>4</small><strong>Share</strong><small>Not available yet</small></li>
      </ol>
      <p className={styles.shareNote}>Public sharing is not available yet. Drafts stay private.</p>
      {saved ? <p className={styles.note} role="status">{saved}</p> : null}
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
      {stale ? (
        <div className={styles.actions}>
          <button className={styles.button} type="button" disabled={pending} onClick={() => void reload()}>Reload saved progress</button>
        </div>
      ) : null}

      <SourceUpload
        sources={sources}
        selection={{ value: sourceChoice, onChange: setSourceChoice }}
        afterList={(
          <div className={styles.actions}>
            <button
              className={!stale && primary === "source" ? styles.button : styles.secondary}
              type="button"
              disabled={pending || stale || !sourceChoice || (!sourceDirty && sourceReady)}
              onClick={() => void save({ documentVersionId: sourceChoice })}
            >
              Save source
            </button>
          </div>
        )}
      />

      <section className={styles.stage} aria-labelledby="audience-heading">
        <div className={styles.stageHeader}>
          <h2 id="audience-heading">Who is this for?</h2>
          <p className={styles.quiet}>Audience and age are saved together.</p>
        </div>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (sourceReady) void save({ audienceLabel: audience, ageBand: age });
          }}
        >
          <label className={styles.field} htmlFor="workflow-audience">
            Audience
            <select id="workflow-audience" value={audience} onChange={(event) => setAudience(event.target.value)} disabled={!sourceReady}>
              <option value="">Select an audience</option>
              {AUDIENCE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className={styles.field} htmlFor="workflow-age">
            Age band
            <select id="workflow-age" value={age} onChange={(event) => setAge(event.target.value)} disabled={!sourceReady}>
              <option value="">Select an age band</option>
              {AGE_BANDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button className={!stale && primary === "audience" ? styles.button : styles.secondary} type="submit" disabled={pending || stale || !sourceReady || audience === "" || age === "" || (!audienceDirty && audienceReady)}>
            Save audience
          </button>
        </form>
      </section>

      <section className={styles.stage} aria-labelledby="topic-heading">
        <div className={styles.stageHeader}>
          <h2 id="topic-heading">Choose a topic</h2>
          <p className={styles.quiet}>A recommendation uses headings and short excerpts. It does not generate a game.</p>
        </div>
        {topicReady ? (
          <p className={styles.note} role="status">Selected topic: {selectedTitle ?? "Saved topic"}</p>
        ) : null}
        <div className={styles.actions}>
          <button className={!stale && primary === "recommend" ? styles.button : styles.secondary} type="button" disabled={pending || stale || !audienceReady} onClick={() => void recommend()}>
            Recommend a starting topic
          </button>
        </div>
        {plan === "choose" && topicView ? (
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              if (topicChoice) void save({ topicCandidateId: topicChoice });
            }}
          >
            <fieldset className={styles.cards}>
              <legend className={styles.quiet}>Choose one eligible topic.</legend>
              {topicView.candidates.filter((candidate) => candidate.eligibility === "eligible").map((candidate) => (
                <label className={styles.card} key={candidate.id}>
                  <span className={styles.sourceChoice}>
                    <input
                      type="radio"
                      name="workflow-topic"
                      value={candidate.id}
                      checked={topicChoice === candidate.id}
                      onChange={() => setTopicChoice(candidate.id)}
                    />
                    {candidate.title}
                  </span>
                </label>
              ))}
            </fieldset>
            <button className={!stale && primary === "topic" ? styles.button : styles.secondary} type="submit" disabled={pending || stale || !topicChoice}>
              Save topic
            </button>
          </form>
        ) : null}
        {plan === "choose" && topicView && topicView.candidates.every((candidate) => candidate.eligibility !== "eligible") ? (
          <p className={styles.help}>None of these topics can be saved yet. A person needs to review them first.</p>
        ) : null}
        {plan === "unavailable" && topicView?.recommendation ? <p className={styles.help}>{topicView.recommendation.reason}</p> : null}
      </section>

      <section className={styles.stage} aria-labelledby="generate-heading">
        <div className={styles.stageHeader}>
          <h2 id="generate-heading">Generate</h2>
        </div>
        <p className={styles.help}>Development fixture. This compiles a private draft from the saved source. It is not live AI generation.</p>
        {draft && draft.status !== "ready" ? <p className={styles.note} role="status">{generationStatusCopy(draft.status)}</p> : null}
        {draft?.status === "failed" ? <p className={styles.alert} role="alert">{generationFailureCopy(draft.failureCode)}</p> : null}
        {!topicReady ? <p className={styles.help}>Save a topic before generation. This page does not start a generation job until you ask.</p> : null}
        {topicReady && !previewId && draft?.status !== "failed" ? (
          <div className={styles.actions}>
            <button
              className={!stale && (primary === "generate" || primary === "continue") ? styles.button : styles.secondary}
              type="button"
              disabled={pending || stale || sourceDirty || audienceDirty}
              onClick={() => void generateDraft()}
            >
              {generationRunning ? "Continue generation" : "Create playable experience"}
            </button>
          </div>
        ) : null}
      </section>

      <section className={styles.stage} aria-labelledby="preview-heading">
        <div className={styles.stageHeader}>
          <h2 id="preview-heading">Preview</h2>
        </div>
        {previewId ? (
          <>
            <p className={styles.note} role="status">Your experience is ready.</p>
            <div className={styles.actions}>
              <Link className={styles.draftLink} href={`/creator/preview/${previewId}`}>Open private preview</Link>
            </div>
          </>
        ) : <p className={styles.help}>A private preview appears after a draft exists. Nothing on this page is public.</p>}
      </section>
      <div className={styles.actions}>
        <Link className={styles.secondary} href="/creator">All experiences</Link>
      </div>
    </>
  );
}
