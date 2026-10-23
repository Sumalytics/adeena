"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AUDIENCE_OPTIONS } from "@/app/studio/studio-form";
import type { ExtractedSourceSummary, TopicRecommendationView } from "@/topic/public";
import styles from "./creator.module.css";
import { SourceUpload } from "./source-upload";
import {
  generationFailureCopy,
  generationStatusCopy,
  topicGenerationGate,
  topicRecommendationFailureCopy,
  topicRestrictionCopy,
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

type CreationStage = "source" | "audience" | "topic" | "generate" | "preview";

export function WorkflowEditor({
  workflow,
  sources,
  recommendation,
  generation,
  liveGeneration = false,
}: {
  workflow: CreatorWorkflowView;
  sources: ExtractedSourceSummary[];
  recommendation: TopicRecommendationView | null;
  generation?: WorkflowGenerationState | null;
  liveGeneration?: boolean;
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
  const [reusePermission, setReusePermission] = useState(false);
  const [editingStage, setEditingStage] = useState<CreationStage | null>(null);
  const stageRef = useRef<HTMLElement>(null);
  const previousStage = useRef<CreationStage | null>(null);

  const selectedSource = sources.find((source) => source.documentVersionId === current.documentVersionId);
  const sourceReady = Boolean(current.documentVersionId && selectedSource && (selectedSource.extractionStatus === "complete" || selectedSource.extractionStatus === "partial"));
  const audienceReady = Boolean(current.audienceLabel && current.ageBand);
  const topicReady = Boolean(current.selectedTopicCandidateId);
  const sourceDirty = sourceChoice !== current.documentVersionId;
  const audienceDirty = audience !== (current.audienceLabel ?? "") || age !== (current.ageBand ?? "");
  const plan = topicSavePlan(topicView);
  const previewId = current.experienceVersionId ?? (draft?.status === "ready" ? draft.experienceVersionId : null);
  const generationRunning = Boolean(draft && draft.status !== "ready" && draft.status !== "failed" && draft.status !== "cancelled");
  const naturalStage: CreationStage = previewId
    ? "preview"
    : !sourceReady
      ? "source"
      : !audienceReady
        ? "audience"
        : !topicReady
          ? "topic"
          : "generate";
  const activeStage = editingStage ?? naturalStage;
  const selectedCandidate = topicView?.candidates.find((candidate) => candidate.id === current.selectedTopicCandidateId);
  const suggestedCandidate = selectedCandidate
    ?? topicView?.candidates.find((candidate) => candidate.id === topicView.recommendation?.topicCandidateId)
    ?? topicView?.candidates.find((candidate) => candidate.eligibility === "eligible")
    ?? topicView?.candidates[0];
  const generationGate = topicReady ? topicGenerationGate(selectedCandidate) : null;
  const selectedTitle = selectedCandidate?.title
    ?? (topicView?.recommendation?.topicCandidateId === current.selectedTopicCandidateId ? topicView.recommendation.topicTitle : null);
  const syncKey = `${workflow.version}:${recommendation?.recommendation?.id ?? ""}:${generation?.jobId ?? ""}:${generation?.status ?? ""}`;
  const [seenSync, setSeenSync] = useState(syncKey);
  if (seenSync !== syncKey) {
    setSeenSync(syncKey);
    setCurrent(workflow);
    setSourceChoice(workflow.documentVersionId);
    setReusePermission(false);
    setAudience(workflow.audienceLabel ?? "");
    setAge(workflow.ageBand ?? "");
    setTopicChoice(workflow.selectedTopicCandidateId);
    setTopicView(recommendation);
    setDraft(generation ?? null);
    setStale(false);
  }

  useEffect(() => {
    if (previousStage.current && previousStage.current !== activeStage) stageRef.current?.focus();
    previousStage.current = activeStage;
  }, [activeStage]);

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
      return payload;
    } catch {
      setError("That change did not reach the workspace.");
      return null;
    } finally {
      setPending(false);
    }
  }

  async function saveSourceChoice() {
    if (!sourceChoice) return;
    const chosen = sources.find((source) => source.documentVersionId === sourceChoice);
    if (chosen && !chosen.permissionDeclared && chosen.rightsStatus !== "cleared") {
      if (!reusePermission) return;
      setPending(true);
      setError("");
      try {
        const permission = await fetch("/api/creator/sources", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ documentVersionId: sourceChoice, declaration: "permission-asserted" }),
        });
        if (!permission.ok) {
          setError("Permission for this content could not be recorded. Check the source and try again.");
          return;
        }
      } catch {
        setError("The permission declaration did not reach the workspace.");
        return;
      } finally {
        setPending(false);
      }
    }
    if (await save({ documentVersionId: sourceChoice })) {
      setReusePermission(false);
      setEditingStage(null);
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
        setError(topicRecommendationFailureCopy(view.error));
        if (view.error === "invalid-topic") setEditingStage("source");
        return;
      }
      setTopicView(view);
      setTopicChoice(view.recommendation?.topicCandidateId ?? view.candidates.find((candidate) => candidate.eligibility === "eligible")?.id ?? null);
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
      if (payload.generation?.status === "ready" && payload.generation.experienceVersionId) {
        router.push(`/creator/preview/${payload.generation.experienceVersionId}`);
      } else {
        router.refresh();
      }
    } catch {
      setError("That experience did not reach the workspace.");
    } finally {
      setPending(false);
    }
  }

  const chosenSource = sources.find((source) => source.documentVersionId === sourceChoice);
  const chosenSourceReady = Boolean(chosenSource && (chosenSource.extractionStatus === "complete" || chosenSource.extractionStatus === "partial"));
  const needsReusePermission = Boolean(chosenSource && !chosenSource.permissionDeclared && chosenSource.rightsStatus !== "cleared");
  const effectiveTopicChoice = topicChoice ?? suggestedCandidate?.id ?? null;
  const alternatives = topicView?.candidates.filter((candidate) => candidate.id !== suggestedCandidate?.id) ?? [];
  const stageOrder: CreationStage[] = ["source", "audience", "topic", "generate"];
  const progressPercent = naturalStage === "preview" ? 100 : (stageOrder.indexOf(naturalStage) + 1) * 25;
  const progressLabel = editingStage
    ? `Editing ${editingStage === "source" ? "content" : editingStage}`
    : naturalStage === "preview"
      ? "Ready to play"
      : `Step ${stageOrder.indexOf(naturalStage) + 1} of 4`;

  return (
    <>
      <p className={styles.promise}>Add your content, choose who it is for, and make a private playable game.</p>
      <div className={styles.progress} aria-label="Creation progress">
        <span>{progressLabel}</span>
        <div className={styles.progressTrack} aria-hidden="true"><span style={{ width: `${progressPercent}%` }} /></div>
      </div>

      {(sourceReady || audienceReady || topicReady) ? (
        <section className={styles.savedSummary} aria-labelledby="saved-choices-heading">
          <h2 id="saved-choices-heading">Your choices</h2>
          <dl>
            {sourceReady ? <div><dt>Content</dt><dd>{selectedSource?.filename ?? "Saved source"}</dd>{!previewId ? <button type="button" onClick={() => setEditingStage("source")}>Change</button> : null}</div> : null}
            {audienceReady ? <div><dt>Audience</dt><dd>{current.audienceLabel} · {AGE_BANDS.find(([value]) => value === current.ageBand)?.[1] ?? current.ageBand}</dd>{!previewId ? <button type="button" onClick={() => setEditingStage("audience")}>Change</button> : null}</div> : null}
            {topicReady ? <div><dt>Topic</dt><dd>{selectedTitle ?? "Saved topic"}</dd>{!previewId ? <button type="button" onClick={() => setEditingStage("topic")}>Change</button> : null}</div> : null}
          </dl>
        </section>
      ) : null}

      {saved ? <p className={styles.note} role="status">{saved}</p> : null}
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
      {stale ? <button className={styles.button} type="button" disabled={pending} onClick={() => void reload()}>Reload saved progress</button> : null}

      {activeStage === "source" ? (
        <section ref={stageRef} tabIndex={-1} className={styles.currentStage} aria-labelledby="source-stage-heading">
          <p className={styles.eyebrow}>Start here</p>
          <h2 id="source-stage-heading">Add your content</h2>
          <p>Upload something you created or have permission to use.</p>
          <SourceUpload
            sources={sources}
            selection={{ value: sourceChoice, onChange: (value) => { setSourceChoice(value); setReusePermission(false); } }}
            afterList={sourceChoice && chosenSourceReady ? (
              <>
                {needsReusePermission ? <label className={styles.permissionCheck}>
                  <input type="checkbox" checked={reusePermission} onChange={(event) => setReusePermission(event.target.checked)} />
                  I created this content or have permission to use it to make and share an experience.
                </label> : null}
                <button
                  className={styles.button}
                  type="button"
                  disabled={pending || stale || (!sourceDirty && sourceReady) || (needsReusePermission && !reusePermission)}
                  onClick={() => void saveSourceChoice()}
                >
                  Use this content
                </button>
              </>
            ) : null}
          />
        </section>
      ) : null}

      {activeStage === "audience" ? (
        <section ref={stageRef} tabIndex={-1} className={styles.currentStage} aria-labelledby="audience-heading">
          <p className={styles.eyebrow}>Next</p>
          <h2 id="audience-heading">Who will play?</h2>
          <p>Choose the group and age range so the language fits.</p>
          <form className={styles.form} onSubmit={async (event) => {
            event.preventDefault();
            if (sourceReady && await save({ audienceLabel: audience, ageBand: age })) setEditingStage(null);
          }}>
            <div className={styles.compactFields}>
              <label className={styles.field} htmlFor="workflow-audience">Audience
                <select id="workflow-audience" value={audience} onChange={(event) => setAudience(event.target.value)}>
                  <option value="">Choose a group</option>
                  {AUDIENCE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>
              <label className={styles.field} htmlFor="workflow-age">Age range
                <select id="workflow-age" value={age} onChange={(event) => setAge(event.target.value)}>
                  <option value="">Choose an age</option>
                  {AGE_BANDS.map(([value, label]) => <option key={value} value={value}>{label}</option>) }
                </select>
              </label>
            </div>
            <button className={styles.button} type="submit" disabled={pending || stale || audience === "" || age === "" || (!audienceDirty && audienceReady)}>Save and continue</button>
          </form>
        </section>
      ) : null}

      {activeStage === "topic" ? (
        <section ref={stageRef} tabIndex={-1} className={styles.currentStage} aria-labelledby="topic-heading">
          <p className={styles.eyebrow}>Choose the focus</p>
          <h2 id="topic-heading">What should the game teach?</h2>
          {!topicView ? (
            <>
              <p>We’ll suggest a focused topic from your content. This does not start game generation.</p>
              <button className={styles.button} type="button" disabled={pending || stale || !audienceReady} onClick={() => void recommend()}>{pending ? "Finding a topic…" : "Suggest a topic"}</button>
            </>
          ) : null}
          {topicView && suggestedCandidate ? (
            <form className={styles.form} onSubmit={async (event) => {
              event.preventDefault();
              if (effectiveTopicChoice && await save({ topicCandidateId: effectiveTopicChoice })) setEditingStage(null);
            }}>
              <fieldset className={styles.topicFieldset}>
                <legend>Suggested topic</legend>
                <label className={styles.topicCard} data-selected={effectiveTopicChoice === suggestedCandidate.id ? "true" : undefined}>
                  <input type="radio" name="workflow-topic" value={suggestedCandidate.id} checked={effectiveTopicChoice === suggestedCandidate.id} disabled={suggestedCandidate.eligibility !== "eligible"} onChange={() => setTopicChoice(suggestedCandidate.id)} />
                  <span><strong>{suggestedCandidate.title}</strong><small>{topicRestrictionCopy(suggestedCandidate)}</small></span>
                </label>
              </fieldset>
              {alternatives.length > 0 ? (
                <details className={styles.disclosure}>
                  <summary>Choose a different topic</summary>
                  <div className={styles.alternatives}>
                    {alternatives.map((candidate) => (
                      <label className={styles.topicCard} key={candidate.id} data-selected={effectiveTopicChoice === candidate.id ? "true" : undefined}>
                        <input type="radio" name="workflow-topic" value={candidate.id} checked={effectiveTopicChoice === candidate.id} disabled={candidate.eligibility !== "eligible"} onChange={() => setTopicChoice(candidate.id)} />
                        <span><strong>{candidate.title}</strong><small>{topicRestrictionCopy(candidate)}</small></span>
                      </label>
                    ))}
                  </div>
                </details>
              ) : null}
              {topicView.candidates.every((candidate) => candidate.eligibility !== "eligible") ? <p className={styles.alert}>No topic is ready for a private game. Use a fuller ordinary section, improve the source headings, or upload more focused content.</p> : null}
              {plan === "unavailable" && topicView.recommendation ? <p className={styles.alert}>{topicView.recommendation.reason}</p> : null}
              <button className={styles.button} type="submit" disabled={pending || stale || !effectiveTopicChoice || topicGenerationGate(topicView.candidates.find((candidate) => candidate.id === effectiveTopicChoice)).allowed === false}>Use this topic</button>
            </form>
          ) : null}
        </section>
      ) : null}

      {activeStage === "generate" ? (
        <section ref={stageRef} tabIndex={-1} className={styles.currentStage} aria-labelledby="generate-heading">
          <p className={styles.eyebrow}>Ready</p>
          <h2 id="generate-heading">Create your playable game</h2>
          <p>Your game will stay private until you review and choose to share it.</p>
          {draft && draft.status !== "ready" ? <p className={styles.note} role="status">{generationStatusCopy(draft.status)}</p> : null}
          {draft?.status === "failed" ? <p className={styles.alert} role="alert">{generationFailureCopy(draft.failureCode)}</p> : null}
          {generationGate && !generationGate.allowed ? <p className={styles.alert}>{generationGate.message}</p> : null}
          {generationGate?.allowed && !previewId && draft?.status !== "failed" ? (
            <button className={styles.button} type="button" disabled={pending || stale || sourceDirty || audienceDirty} onClick={() => void generateDraft()}>
              {generationRunning ? "Continue generation" : "Generate my experience"}
            </button>
          ) : null}
          <details className={styles.disclosure}>
            <summary>How generation works</summary>
            <p>{liveGeneration ? "This sends the selected excerpts, topic and audience to the configured AI model. The server checks the plan and simulates every path. Pressing Generate authorizes this bounded request; playback needs no AI." : "This development server uses a deterministic fixture instead of a live AI model. Pressing Generate creates a private draft from the saved source."}</p>
          </details>
        </section>
      ) : null}

      {activeStage === "preview" && previewId ? (
        <section ref={stageRef} tabIndex={-1} className={styles.currentStage} aria-labelledby="preview-heading">
          <p className={styles.eyebrow}>Your game is ready</p>
          <h2 id="preview-heading">Play your private draft</h2>
          <p>Try every path, improve anything that needs work, then share when you are ready.</p>
          <Link className={styles.draftLink} href={`/creator/preview/${previewId}`}>Open private preview</Link>
        </section>
      ) : null}

      <div className={styles.footerLink}><Link href="/creator">Back to all experiences</Link></div>
    </>
  );
}
