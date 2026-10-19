import { modelHarness } from './model-selection.ts';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export interface AgentSpec {
  harness: string;
  model: string;
  effort?: string;
}

/**
 * One repeatable CLI value describes one independently configurable agent.
 *
 *     claude:opus:high
 *     codex:gpt-5.6-terra:xhigh
 *     claude::medium             (default model)
 */
export function parseAgentSpec(spec: string, defaultModels: Record<string, string>): AgentSpec {
  const parts = spec.split(':');
  if (parts.length > 3) {
    throw new Error(`invalid --agent ${spec}: expected harness[:model[:effort]]`);
  }

  const [harness = '', requestedModel = '', effort = ''] = parts;
  if (!defaultModels[harness]) {
    throw new Error(
      `unknown harness in --agent ${spec}: ${harness || '(empty)'}\n` +
        `Known: ${Object.keys(defaultModels).join(', ')}`,
    );
  }

  const model = requestedModel || defaultModels[harness];
  const owner = modelHarness(model);
  if (owner && owner !== harness) {
    throw new Error(`model ${model} belongs to ${owner}, not ${harness}`);
  }
  if (effort && !/^[a-z][a-z0-9_-]*$/.test(effort)) {
    throw new Error(`invalid effort in --agent ${spec}: use a CLI effort name such as high or xhigh`);
  }
  if (effort && !EFFORTS.has(effort)) {
    throw new Error(`unknown effort in --agent ${spec}: ${effort}`);
  }
  if (harness === 'claude' && effort && !CLAUDE_EFFORTS.has(effort)) {
    throw new Error(`Claude Code does not support effort ${effort}`);
  }

  return { harness, model, ...(effort ? { effort } : {}) };
}

export function agentKey(agent: AgentSpec): string {
  return `${agent.harness}/${agent.model}/${agent.effort ?? 'default'}`;
}
