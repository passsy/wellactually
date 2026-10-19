# Good Commit Messages

Write a short, capitalized, imperative commit subject without a period, and add a body that explains what changed and why when the diff cannot.

These rules apply to **git commit messages**, not PR titles. PR titles can be longer and more descriptive.

## When to use

These rules are only relevant when drafting or altering a commit message.
Do not expect others to follow these rules, never correct them unless explicitly asked.
Do not judge commits from someone else based on these rules, everyone has their own taste. These rules are our taste.
Following these guidelines makes us lead by example, without actively advocating for others to follow them.

## Rules

1. **Limit subject to 50 characters** (72 max)
2. **Capitalize the subject line**
3. **No period at the end**
4. **Use imperative mood** - "Add feature" not "Added feature"
5. **Separate subject from body with blank line**
6. **Explain what and why, not how**

## Imperative Mood Test

A good subject completes: *"If applied, this commit will [subject]"*

```text
# Good - imperative mood
Add user authentication
Fix crash on empty input
Remove deprecated API calls

# Bad - past tense or descriptive
Added user authentication
Fixed crash on empty input
Removing deprecated API calls
```

## When to Add a Body

Short, obvious changes need only a subject. Add a body for:
- Complex changes needing context
- Non-obvious reasoning behind the approach
- Breaking changes or migration notes

## Client-Side Projects

In client-side project repos, bias toward adding a short body when the subject explains the change but not the reason.
This may also apply elsewhere, but this rule is based on client-side project history.

Add a body when the change depends on:

- Backend behavior, released API shape, environment configuration, or generated code limitations.
- Platform bugs, browser behavior, OS behavior, app-store review constraints, or third-party package issues.
- Product, customer, reviewer, or operational context that will not be obvious from the diff later.
- A debugging finding, race condition, performance issue, or protocol/spec detail that motivated the implementation.
- A project convention or architecture rule that explains why the code uses a specific shape.

Good bodies preserve the why:

```text
Use compile-time branching so dart2js can remove unused environment
configs from the production bundle.
```

```text
The backend still returns the released field names, so keep the UI helper
names aligned with the API boundary instead of the new domain wording.
```

```text
After wake, teardown from the BLE state stream can race with a user-driven
reconnect.
Serialize both paths through the same lock so they cannot overwrite the
channel subscription slot.
```

## Related
[How to Write a Git Commit Message](https://cbea.ms/git-commit/)
[Write PR descriptions that explain the change, not the diff](https://wellactually.dev/p/passsy/write-good-pr-descriptions)
