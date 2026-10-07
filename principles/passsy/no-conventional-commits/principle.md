# No conventional commit prefixes

Write the subject as a sentence about the change; prefixes like feat and fix spend the best characters of the line on a category.

A commit subject has about fifty characters to say what changed.
`feat(auth): add login` spends eleven of them on a category the diff already shows.

Write the subject as a plain imperative sentence that starts with a capital letter.

```text
Bad:  feat(auth): add passkey login
Bad:  fix: crash on empty cart
Good: Add passkey login
Good: Stop the cart from crashing when it is empty
```

If the repository's own history uses conventional commits consistently, follow the repository.
Its convention wins over this principle.
