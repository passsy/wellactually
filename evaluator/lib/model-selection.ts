const CLAUDE_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable']);

/** The owning harness when the model name makes that unambiguous. */
export function modelHarness(model: string): 'claude' | 'codex' | null {
  if (CLAUDE_ALIASES.has(model) || model.startsWith('claude-')) {
    return 'claude';
  }
  if (model.startsWith('gpt-')) {
    return 'codex';
  }
  return null;
}
