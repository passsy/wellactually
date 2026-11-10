# Prepare the working tree and diff

Coordinator step 2: read task.md and follow the preparation commands in the installed SKILL.md. For a Git revision, reuse a clean assigned worktree at the review HEAD or let the helper create a detached worktree. Review local changes in place; use the assigned directory directly without Git.
Pass the existing artifact directory with --out so task.md and context.md remain alongside the generated plan and diff. The helper generates diff.patch, bounded diff parts, copied step instructions and plan.json. It creates no source/ or before/ folders and does not load the advisory board at this stage.
Reconcile the brief's exact scope with the actual plan.root, base/head and automatic omissions. Preserve staged, unstaged and selected untracked contents for a local-change review. Do not substitute branch commits for local changes or invent a baseline for current-file reviews.
