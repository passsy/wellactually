# Writing Markdown

Write markdown with one sentence per line, no wrapping, dash bullets, ATX headings and tagged code fences, and run markdownlint-cli2 after every edit.

Applies to:

- All `.md` files in a repository (docs, README, CHANGELOG).
- Markdown rendered on GitHub: PR descriptions, issue bodies, release notes, PR and issue comments.

Does not apply to commit messages.
See [Good Commit Messages](https://wellactually.dev/p/passsy/good-commit-messages) for commit message rules.

## Rules

1. **One sentence per line.**
   A new sentence starts on a new line.
   This enables line-level diffs and makes review comments land on the specific sentence that changed.
2. **No line length limit.**
   Do not wrap prose at column 80 or any other column.
   Long URLs, long code references, and long sentences stay on a single line.
3. **Bullets with multiple sentences split across lines with 2-space indent continuation.**
   The second and later sentences go on new lines, indented by 2 spaces so they render as part of the same bullet.
4. **Dash for bullets** (`-`).
   Never `*` or `+`.
5. **ATX-style headings** (`# `, `## `, `### `).
   Never setext (`===`, `---` under the text).
6. **Fenced code blocks require a language tag.**
   Use `` ```dart ``, `` ```bash ``, `` ```text ``, `` ```jsonc ``, etc.
   Use `` ```text `` for plain output when no language fits.
7. **File ends with a trailing newline.**
8. **Blank line above headings is required.**
   A blank line below a heading is optional.
   Blank lines around lists, fenced code blocks, and tables are optional, adjacent label-then-list or heading-then-table patterns are allowed.
9. **No required h1.**
   Files do not need to start with a top-level heading.

## One sentence per line

Good:

```markdown
The trainer broadcasts power every 250ms.
Clients subscribe to the Cycling Power Service.
When the trainer disconnects the session pauses automatically.
```

Bad (multiple sentences on one line):

```markdown
The trainer broadcasts power every 250ms. Clients subscribe to the Cycling Power Service. When the trainer disconnects the session pauses automatically.
```

Bad (prose wrapped at column 80 mid-sentence):

```markdown
The trainer broadcasts power every 250ms. Clients subscribe to the Cycling
Power Service. When the trainer disconnects the session pauses
automatically.
```

## Bullets with multiple sentences

Good:

```markdown
- The device manager holds all connected devices.
  It also re-publishes the controller source list when a device attaches late.
- Controllers debounce rising edges across paired endpoints.
```

Bad (second sentence inline):

```markdown
- The device manager holds all connected devices. It also re-publishes the controller source list when a device attaches late.
- Controllers debounce rising edges across paired endpoints.
```

Bad (second sentence as a sibling bullet):

```markdown
- The device manager holds all connected devices.
- It also re-publishes the controller source list when a device attaches late.
- Controllers debounce rising edges across paired endpoints.
```

## Fenced code blocks need a language tag

Good:

````markdown
```dart
final beacon = Beacon.writable(0);
```
````

Good (plain output, no language fits):

````markdown
```text
Connected: Wahoo Kickr
```
````

Bad (no language):

````markdown
```
final beacon = Beacon.writable(0);
```
````

## Linting

Run `markdownlint-cli2` after every markdown edit, before declaring the task done:

```bash
markdownlint-cli2 --config ~/.markdownlint-cli2.jsonc path/to/file.md
```

Always pass `--config ~/.markdownlint-cli2.jsonc` explicitly.
markdownlint-cli2 only walks up to the current working directory when searching for config, so a config in `$HOME` is **not** auto-discovered from a project subdirectory.
Passing `--config` makes the tool behave consistently regardless of cwd.

Fix every violation the tool reports.
Do not dismiss violations as "pre-existing".

### Installing markdownlint-cli2

macOS:

```bash
brew install markdownlint-cli2
```

Other platforms:

```bash
npm install -g markdownlint-cli2
```

### Global config

The shared config lives at `~/.markdownlint-cli2.jsonc` and must be passed via `--config`.

It disables:

- `MD013` (line-length)
- `MD031` (blanks around fences)
- `MD032` (blanks around lists)
- `MD033` (inline HTML, needed for `<details>`, sized images, etc.)
- `MD041` (first line must be h1)
- `MD058` (blanks around tables)

It pins bullet style to dash and heading style to ATX, sets `MD024` to `siblings_only: true` so that repeated subheadings (e.g., `### Purpose` under two different `##` sections) are allowed, and relaxes `MD022` so that a blank line below a heading is optional.
Everything else comes from the `default: true` ruleset.

## What markdownlint cannot enforce

- **One sentence per line.**
  There is no markdownlint rule for this.
  Check manually: look for `. ` (period followed by space) inside paragraphs and bullet text.
- **Whether a continuation sentence should live inside the current bullet or become a new bullet.**
  Use judgment: if the second sentence elaborates on the first, keep it in the same bullet.
  If it is a separate point, make it a sibling bullet.
