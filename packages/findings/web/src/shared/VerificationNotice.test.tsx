import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Finding } from "./domain.ts";
import { VerificationNotice } from "./VerificationNotice.tsx";

const finding: Finding = { id: "G1", title: "Suspected issue", body: "Possible failure.\n\nCheck the affected path.", evidence: "Speculative", priority: "p2", anchor: { file: "a.ts", line: 3, commit: "head" }, snippet: "value();", fingerprint: "fixture", verdict: "undecided", resolution: "unresolved", history: [], links: {}, createdAt: "2026-11-02T00:00:00Z", verificationBlock: { at: "2026-11-02T00:00:00Z", reason: "Provider rejected the proof request", candidates: ["C1"] } };

describe("verification visibility", () => {
  test("makes an unverified blocked claim and its reason visible without declaring a security defect", () => {
    render(<VerificationNotice finding={finding} />);
    expect(screen.getByRole("note")).toHaveTextContent("Unverified — verification blocked");
    expect(screen.getByRole("note")).toHaveTextContent("Provider rejected the proof request");
    expect(screen.getByRole("note")).toHaveTextContent("does not establish a security defect");
  });
  test("a blocked later attempt does not erase existing proof", () => {
    render(<VerificationNotice finding={{ ...finding, evidence: "Proven", provenTest: "node probe.mjs" }} />);
    expect(screen.getByRole("note")).toHaveTextContent("Further verification blocked");
    expect(screen.getByRole("note")).not.toHaveTextContent("Unverified —");
  });
  test("an ordinary unresolved proof has its own unverified label", () => {
    const { verificationBlock: _, ...plain } = finding;
    render(<VerificationNotice finding={{ ...plain, verification: { status: "plausible", reason: "Native runtime unavailable" } }} />);
    expect(screen.getByRole("note")).toHaveTextContent("Unverified — further evidence needed");
    expect(screen.getByRole("note")).toHaveTextContent("Native runtime unavailable");
  });
});
