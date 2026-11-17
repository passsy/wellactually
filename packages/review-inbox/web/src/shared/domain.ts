/**
 * The server's own vocabulary, imported rather than restated.
 *
 * These modules are pure — types, frozen lists, and a few functions of a
 * finding's own fields — so a browser can have them as they are. That matters
 * more than it sounds: a finding's shape is written down once, and a page that
 * renders a field the server stopped writing stops compiling rather than
 * rendering an empty span. The counting is here for a sharper reason still:
 * the page counts the review it is holding rather than asking the server what
 * it just did itself, and one function means the two answers agree.
 *
 * This is the only place the web code reaches outside its own directory. If
 * something over there stops being pure, it gets an API route, not a copy.
 */

export type {
  Anchor,
  Authorship,
  FindingList,
  ReviewCounts,
  ReviewPr,
  ReviewState,
  ReviewStatus,
  ReviewSummary,
  SeenMap,
  Evidence,
  Finding,
  FindingLinks,
  Priority,
  RelatedLocation,
  Reporter,
  Resolution,
  SourceContext,
  Verdict,
} from "../../../model/types.mts";

export {
  AUTHORSHIP_SAYS,
  EVIDENCE,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  PRIORITY,
  RESOLUTION,
  VERDICT,
} from "../../../model/types.mts";

export { isUnseen } from "../../../model/unread.mts";

export { countsOf, hasNote } from "../../../model/counts.mts";

export {
  GROUP_ORDER,
  GROUP_TITLES,
  groupOf,
  type GroupKey,
} from "../../../model/groups.mts";

export {
  LEVELS,
  levelOfFinding,
  type LevelStatus,
} from "../../../model/levels.mts";
