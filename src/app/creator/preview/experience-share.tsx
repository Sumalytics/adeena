"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import styles from "../../auth.module.css";
import layout from "./experience-editor.module.css";
import share from "./experience-share.module.css";

type Status = {
  eligible: boolean; blocks: string[]; sourceName: string; canClearRights: boolean;
  rightsBasis: string | null; rightsRecordedAt: string | null;
  release: { releaseId: string; playPath: string; revoked: boolean } | null;
};
const reasons: Record<string, string> = {
  "owner-required": "Only the workspace owner can publish. Ask the owner to review this version.",
  "rights-blocked": "This source is blocked. Use a permitted source; creator clearance cannot override this restriction.",
  "rights-clearance-required": "Record rights clearance for this exact source below.",
  "independent-review-required": "Sensitive or high-risk source content requires independent review. Creator approval cannot override it; publication is unavailable in this workflow.",
  "version-review-required": "This version still requires review or acceptance. Accept eligible proposals first. Changes requiring independent review cannot be self-approved here.",
  "validation-required": "The playable version has not passed validation. Return to the experience and prepare a valid draft.",
  "public-content-review-required": "Learner-facing content contains unsupported assets, links or sensitive content. Revise it and review the new version before publishing.",
  "release-revoked": "This version was revoked permanently. Prepare and review a new version to share again.",
  "version-unavailable": "This version is unavailable. Return to your experience.",
};

export function ExperienceShare({ versionId }: { versionId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [basis, setBasis] = useState("creator-owned");
  const [evidence, setEvidence] = useState("");
  const [permission, setPermission] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [note, setNote] = useState("");
  const [approved, setApproved] = useState(false);
  const [url, setUrl] = useState("");
  const [qr, setQr] = useState("");

  async function refresh() {
    const response = await fetch(`/api/creator/releases?versionId=${versionId}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not check publication eligibility. Sign in and try again.");
    setStatus(await response.json());
  }
  useEffect(() => {
    let active = true;
    fetch(`/api/creator/releases?versionId=${versionId}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Could not check publication eligibility. Sign in and try again.");
      const payload: Status = await response.json();
      if (active) setStatus(payload);
    }).catch((error: Error) => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, [versionId]);
  const playPath = status?.release && !status.release.revoked ? status.release.playPath : null;
  useEffect(() => {
    if (!playPath) return;
    let active = true;
    const canonical = new URL(playPath, window.location.origin).href;
    QRCode.toDataURL(canonical, { width: 224, margin: 4, errorCorrectionLevel: "M" }).then((data) => {
      if (active) { setUrl(canonical); setQr(data); }
    }).catch(() => { if (active) { setUrl(canonical); setMessage("QR code unavailable. You can still copy the link."); } });
    return () => { active = false; };
  }, [playPath]);

  async function act(kind: "rights" | "publish" | "revoke") {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(kind === "rights" ? "/api/creator/releases/rights" : kind === "publish" ? "/api/creator/releases" : `/api/creator/releases/${status?.release?.releaseId}`, {
        method: kind === "revoke" ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        ...(kind === "revoke" ? {} : { body: JSON.stringify(kind === "rights" ? {
          experienceVersionId: versionId, basis, evidence, permitsPublicAdaptation: permission,
        } : { experienceVersionId: versionId, approval: {
          experienceVersionId: versionId, decision: "approved", contentReviewed: true,
          privacy: "no-identifiable-learner", unresolvedHighRisk: false, note,
        } }) }),
      });
      if (!response.ok) throw new Error("This action could not be completed. Check eligibility and your session, then try again.");
      await refresh();
      setMessage(kind === "rights" ? "Rights clearance recorded with your identity and timestamp." : kind === "publish" ? "Published. This link always plays the reviewed version." : "Revoked. New learner requests can no longer open this release.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Please try again.");
      await refresh().catch(() => setStatus(null));
    } finally { setBusy(false); }
  }

  return <section className={`${layout.editor} ${share.section}`} aria-labelledby="share-heading" aria-busy={busy}>
    <h2 id="share-heading" className={styles.subhead}>Share</h2>
    <p>Publish this reviewed version for anyone with its link. Later draft edits stay private.</p>
    <p className={share.version}>Version: {versionId}</p>
    {!status ? <><p>Publication eligibility is not available yet.</p><button className={styles.quiet} onClick={() => refresh().catch((error: Error) => setMessage(error.message))}>Retry eligibility check</button></> : <>
      {status.blocks.length > 0 ? <div className={styles.note}><strong>Publishing blocked</strong><ul>{status.blocks.map((reason) => <li key={reason}>{reasons[reason] ?? "Publication requires further review."}</li>)}</ul></div> : <p className={styles.note}>{status.release ? "This version has been published." : "Eligible for your review and approval."}</p>}
      <p>Source: {status.sourceName}</p>
      {status.rightsBasis ? <p>Rights clearance: {status.rightsBasis}, recorded {new Date(status.rightsRecordedAt!).toLocaleString()}. This is a creator attestation, not independent verification.</p> : null}
      {status.canClearRights && !status.release ? <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void act("rights"); }}>
        <h3>1. Clear source rights</h3>
        <p>Upload declarations do not clear rights. Record the basis and evidence permitting public adaptation and sharing of this source. This permanent record stays private.</p>
        <label>Rights basis<select value={basis} onChange={(event) => setBasis(event.target.value)}><option value="creator-owned">I own the content</option><option value="licensed">I hold a licence permitting this use</option></select></label>
        <label>Ownership or licence evidence<textarea required minLength={20} maxLength={2000} value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="Describe authorship, or identify the licence, rights holder and permission to adapt and share publicly." /></label>
        <label className={share.check}><input type="checkbox" required checked={permission} onChange={(event) => setPermission(event.target.checked)} />I confirm I may adapt this exact source and share the resulting learner experience publicly.</label>
        <button disabled={busy || !permission || evidence.trim().length < 20}>Record rights clearance</button>
      </form> : null}
      {status.eligible && !status.release ? <div className={styles.form}>
        <h3>2. Review this experience</h3>
        <p>Play every path above. Check accuracy, source support, age suitability and privacy. Sensitive or high-risk content requires independent review.</p>
        <label className={share.check}><input type="checkbox" checked={reviewed} disabled={busy} onChange={(event) => { setReviewed(event.target.checked); setApproved(false); }} />I reviewed this exact playable version, including every outcome. It has no identifiable learner information or unresolved high-risk content.</label>
        <label>Review note<textarea minLength={10} maxLength={1000} value={note} disabled={busy} onChange={(event) => { setNote(event.target.value); setApproved(false); }} /></label>
        <button disabled={busy || !reviewed || note.trim().length < 10 || approved} onClick={() => setApproved(true)}>{approved ? "Version approved for publication" : "Approve this version"}</button>
        <p>Publishing records your approval note, identity and timestamp with this fixed release.</p>
        <button disabled={busy || !approved} onClick={() => void act("publish")}>Publish</button>
      </div> : null}
      {playPath ? <div className={styles.form}>
        <h3>Share with a learner</h3>
        <label>Canonical URL<input readOnly value={url} onFocus={(event) => event.target.select()} /></label>
        <button disabled={!url || busy} onClick={async () => { try { await navigator.clipboard.writeText(url); setMessage("Link copied."); } catch { setMessage("Copy unavailable. Select and copy the URL above."); } }}>Copy link</button>
        {qr ? <div className={share.qr}>
          {/* Generated locally as a data URL; no remote image request. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} width={224} height={224} alt="QR code for the learner link" />
        </div> : null}
        <a className={styles.textLink} href={playPath} target="_blank" rel="noopener noreferrer">Open as learner</a>
        <p>Revocation is permanent for this version. Content already delivered cannot be recalled; open players recheck periodically.</p>
        <button disabled={busy} onClick={() => { if (window.confirm("Permanently revoke this version’s learner link?")) void act("revoke"); }}>Revoke</button>
      </div> : null}
    </>}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
