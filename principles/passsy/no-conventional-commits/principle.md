# Avoid Conventional Commits

Describe what changed and why in the commit subject instead of prefixing it with feat:, fix: or chore:, which add noise the diff already shows.

Do not use [Conventional Commits](https://www.conventionalcommits.org/) format for commit messages. Avoid prefixes like `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, etc.

## Why?

- **Redundant information**: The type of change is already visible in the diff
- **Noise over signal**: Prefixes add visual clutter without adding meaning
- **False categorization**: Many changes don't fit neatly into categories, leading to arbitrary choices
- **Tooling dependency**: Assumes automated changelog generation, which often produces low-quality output
- **Verbosity**: Takes space away from describing what actually changed

## Instead

Write commit messages that describe **what** changed and **why**:

```
# Bad
feat: add user authentication
fix: resolve login button issue
chore: update dependencies

# Good
Add user authentication with OAuth2
Fix login button not responding on iOS
Update dependencies to patch security vulnerabilities
```

Focus on clear, action-oriented messages that tell the story of the change.
