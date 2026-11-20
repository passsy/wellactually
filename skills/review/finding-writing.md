# How a finding reads

A finding is read once, by someone deciding whether to change their code.
Everything in its title and description has to help with that decision.
This standard applies when creating a finding, verifying it, and posting it.

## The shape

Unless the finding fits in one line, its description has this shape:

1. One sentence that says what breaks, for whom, and when.
2. At most two short sentences on why, naming the code that causes it.
3. A blank line, then the fix as its own paragraph.

Parallel cases become a list.

Before, as a reviewer deep in the code wrote it:

```text
Deleting a fixture through a connected proxy can remove it from the project while leaving it in mesh storage. If the exclusion write fails, `MeshStorage.removeDevice` throws before deleting the node and Device Key. `BleManager.unprovisionDevice` swallows that failure, so `ProjectManager.removeNodes` deletes the project entry. Let local storage failures reach the caller. `InternalDeviceManager.unprovisionNode` already handles reset delivery failures separately.
```

After:

```markdown
Deleting a fixture through a connected proxy can remove it from the project while its node stays in mesh storage.

When the exclusion write fails, `MeshStorage.removeDevice` throws before deleting the node, and `BleManager.unprovisionDevice` swallows the error, so `ProjectManager.removeNodes` deletes the project entry anyway.

Let local storage failures reach the caller so the project keeps the fixture for retry.
```

## Length follows the argument

Length follows the argument, not a limit.

A typo, a missing `await`, a commented-out block: one line.
Name it, name the fix, stop.
Nothing else is owed: not a fenced block when the fix fits in the sentence, not a second sentence arguing for a fix nobody will argue with.

Two entire findings, for scale:

- `pubish()` → `publish()`
- The `StreamSubscription` from `listen()` is never cancelled, so it outlives the widget.

An architecture finding is the opposite case.
It is the kind of disagreement that would otherwise be settled in a call, and there is no call, so the whole case has to survive as text.
Write what the current approach commits the project to, what it costs when the next feature lands, what the alternative is, and what would talk you out of it.
Long enough that the author can act or disagree without booking a call.

## How it is written

- **The title is the headline.**
  A short name for the defect or the change needed: `Restore Retry after a deferred download fails`.
  Not the whole scenario in one sentence, and no IDs, priorities or rule names.
- **Open with what is broken.**
  Not the mechanism, not the type signature, not the rule it violates.
  The author decides whether to keep reading from the first sentence.
- **Name things exactly.**
  `didUpdateWidget`, `dragUntilVisible`, `enterPin(List<int> pin)`, not "the lifecycle method".
- **Argue from what breaks later.**
  What stops being noticed, what has to be maintained twice, what fails when the screen grows.
  Not what is untidy.
- **Show the code you would rather see.**
  Three lines of the assertion you want beat a paragraph describing it.
  Only the lines that change.
  A block that repeats five unchanged lines to show where one keyword goes is not showing anything.
- **Ask when you are actually asking.**
  A question invites an answer, and the author may know something you do not.
  Do not dress a decision up as one.
- **Do not hedge a defect.**
  Preferences get "I'd" and "IMHO"; a bug gets a flat sentence.
  Missing test coverage is a coverage gap, not an observed production failure.
- **An observation without a fix is still a finding.**
  "This test runs for 1:50min" is worth writing without knowing why.
- **Leave the bookkeeping out of the prose.**
  Impact, evidence and why no test was written are fields on the finding, not sentences in it.
  So is the location: the finding already points at the line, so the description does not open by quoting the code back at its author.
- **Leave the review's labels out too.**
  Do not open with "Change finding", "pre-existing defect", "Proven" or an account of what you inspected.
  Whether a defect is introduced, newly exposed or pre-existing goes into the finding's tags.
  Mention an old defect the change newly reaches only where that changes what the author does, in one sentence.

Inline `code`, bullets and short fenced blocks are welcome.
A long finding needs them most: they are what keeps a written-out argument readable.

## Write it as a news story, not as a lab notebook

This is the single thing that decides whether a finding gets read.

A lab notebook records an investigation in the order it happened: here is what I looked at, here is what the code does, therefore here is the problem, so do this.
That is the order you found it in, and it is the wrong way round for everyone else.
It is also what a finding turns into by default, because writing it up straight after the digging feels like continuing the same sentence.

A news story is an **inverted pyramid**.
The headline is the news.
The first sentence is the whole story for a reader who stops there.
Everything after it descends in importance, so the reader stops when they have enough and nothing they needed was below the cut.
Enumerations get broken out, because a paragraph is a bad place to hide a list.

Same finding, both ways:

```markdown
Lab notebook:
The only SyncManager queue tests count timestamps for initial fixture
synchronization and a mid-drain addition. They never assert queued command
identity, make subscribe/unsubscribe calls observable, inject a dispatch
error, replace the connection, call either flush branch, or dispose during a
delay. The new queue's supersession matrix, null-connection behavior, error
continuation, flush semantics, and cancellation can therefore change without
those tests noticing. Add direct MeshCommandQueue tests.

News story:
`MeshCommandQueue` can change behaviour without a single test failing.

The only queue tests count timestamps. Nothing asserts:

- queued command identity
- a dispatch error mid-drain
- the connection being replaced
- either `flush` branch

Add direct `MeshCommandQueue` tests asserting the ordered items and the
lifecycle result per branch.
```

Same words, a quarter of the reading effort.
Nothing here is a length limit: a one-line finding is already an inverted pyramid, and an architecture argument that runs a page is one too.

When a failing test proves the finding, say in one sentence what it shows.
It is the strongest thing in the review, and a description that never mentions it throws that away.

The tone to aim for is plain, not sharp.
A reviewer who knows the author can be blunt and be read as direct; a review that arrives as text has none of that credit and reads harsher than it was meant.

## Keep the investigation in its fields

Commands, local proof paths, runtime versions, full output, detailed expected/actual results, rule quotes and investigation limits belong in evidence or assessments.
Locations belong on occurrences.

During verification, keep a description that already reads well unless the checked evidence changes it.
Correct the title and claim in place, then reread them as the author would.
Adding evidence must not turn the description into an investigation transcript.
Preserve user notes, disposition, other evidence and assessments.

An occurrence description says only what is different about that instance.
Omit it when its location and the shared finding already explain it; do not repeat the defect above every code block.
