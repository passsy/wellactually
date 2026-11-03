import type { Finding } from "./domain.ts";

/** A request being blocked says nothing about whether the product claim is true. */
export function VerificationNotice({ finding }: { finding: Finding }) {
  if (finding.verificationBlock) return (
    <p className="meta mb-4" role="note">
      <strong>{finding.evidence === "Proven" ? "Further verification blocked" : "Unverified — verification blocked"}</strong>
      {": "}{finding.verificationBlock.reason}
      {" The finding remains available for human review; this does not establish a security defect."}
    </p>
  );
  if (finding.verification?.status === "refuted") return (
    <p className="meta mb-4" role="note"><strong>Verification no longer supports this finding</strong>{": "}{finding.verification.reason}</p>
  );
  if (finding.verification?.status === "plausible") return (
    <p className="meta mb-4" role="note"><strong>Unverified — further evidence needed</strong>{": "}{finding.verification.reason}</p>
  );
  return null;
}
