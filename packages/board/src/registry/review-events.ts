export type ReviewPriority = "p0" | "p1" | "p2" | "p3" | "p4";
interface Base { id: string; principle: string; revision: number; occurred_at: string; }
/**
 * A review rating: what a review did with a principle, sent to the registry's `/api/review-events`.
 * "Review rating" and "review result" name the same thing, this type; there is no separate review result.
 * Not to be confused with the advice ratings an agent gives a principle shown by a hook (`/api/ratings`).
 */
export type ReviewEvent =
  | Base & { type: "review_selection" }
  | Base & { type: "review_suggestion" | "finding_fixed" | "finding_rejected"; priority: ReviewPriority };
export interface RejectedReviewEvent { id: string; principle: string; type: string; reason: string; }
