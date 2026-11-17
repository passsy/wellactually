export type ReviewPriority = "p0" | "p1" | "p2" | "p3" | "p4";
interface Base { id: string; principle: string; revision: number; occurred_at: string; }
export type ReviewEvent =
  | Base & { type: "review_selection" }
  | Base & { type: "review_suggestion" | "finding_fixed"; priority: ReviewPriority };
export interface RejectedReviewEvent { id: string; principle: string; type: string; reason: string; }
