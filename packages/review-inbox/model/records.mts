/** The persisted CRUD model. Workflow decisions belong to callers. */
import type { Anchor, Authorship, Priority, SourceContext } from "./types.mts";

export type RecordState = "open" | "closed";
export interface Closure {
  reason: "resolved" | "rejected" | "disproven" | "superseded";
  explanation: string;
  supersededBy?: string[];
}
export interface RuleLink {
  id: string;
  url?: string;
  note?: string;
}
export interface RecordLink {
  id: string;
  kind: string; // commit, pr, comment, artifact, or another caller-defined relationship
  url?: string;
  commit?: string;
  description?: string;
}
export interface EvidenceEntry {
  id: string;
  kind: "source" | "reasoning" | "test";
  polarity: "supports" | "contradicts";
  description: string;
  artifacts: string[];
  /** Omit for the shared claim; otherwise explicitly scope the evidence. */
  occurrenceIds?: string[];
}
export interface Assessment {
  id: string;
  author: string;
  authorType: "human" | "agent";
  conclusion: string;
  reason: string;
  at: string;
}
export interface RecordChange {
  at: string;
  actor: string;
  revision: number;
  patch: Record<string, unknown>;
}
export interface RecordBase {
  schemaVersion: 2;
  id: string;
  revision: number;
  /** Immutable retry identity, set only on creation. */
  creationKey?: string;
  state: RecordState;
  closure?: Closure;
  evidence: EvidenceEntry[];
  assessments: Assessment[];
  links: RecordLink[];
  createdAt: string;
  updatedAt: string;
  history: RecordChange[];
}
export type FindingVerdict = "undecided" | "accepted" | "invalid" | "tolerated";
export interface FindingRecord extends RecordBase {
  /** User disposition, independent of investigation and resolution. */
  verdict: FindingVerdict;
  /** When the author was told; a comment link is optional and independent. */
  reportedAt?: string;
  title: string;
  description: string;
  rules: RuleLink[];
  priority: Priority;
  tags: string[];
  note?: string;
  origins: {
    run: string;
    source: string;
    unit: string;
    rule?: string;
    quote?: string;
  }[];
  /** Import/provenance information, never used to restrict CRUD transitions. */
  metadata: Record<string, unknown>;
}
export interface OccurrenceLocation extends Anchor {
  note?: string;
  context?: SourceContext;
  diff?: string;
  authorship?: Authorship;
}
export interface OccurrenceRecord extends RecordBase {
  findingId: string;
  description?: string;
  locations: OccurrenceLocation[];
}
export interface OccurrenceSummary {
  updatedAt?: string;
  revisionKey?: string;
  total: number;
  open: number;
  resolved: number;
  closed: number;
}
