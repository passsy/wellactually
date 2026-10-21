# opencode

The plugin for OpenCode, as a package of its own.

```bash
opencode plugin add 'github:passsy/wellactually#path:opencode'
```

OpenCode installs a plugin from git the way npm installs a package, and fails on a repository with workspaces or a build step.
So this folder carries everything itself: a copy of the command from [dist](../dist), the OpenCode plugin and the skills.
The skills are named `wellactually-login`, `wellactually-sync`, `wellactually-disable`, `wellactually-enable` and `wellactually-audit` here, because OpenCode and pi know a skill by its name alone.
OpenCode 2 loads one you mention, as in `@wellactually-login`, and OpenCode 1 offers it as `/wellactually-login`.
pi reads its skills from this folder too.
