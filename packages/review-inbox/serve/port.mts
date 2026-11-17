/** Fixed provider ports prevent one app from taking over another app's findings UI. */
export const REVIEW_PORTS = { claude: 8424, codex: 8425, opencode: 8426, pi: 8427, standalone: 8428 } as const;

export function reviewHost(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): keyof typeof REVIEW_PORTS {
  const index = argv.indexOf("--review-host");
  const explicit = env.WELLACTUALLY_REVIEW_HOST ?? (index >= 0 ? argv[index + 1] : undefined);
  if (explicit) {
    if (!Object.hasOwn(REVIEW_PORTS, explicit)) throw new Error("Unknown findings review host");
    return explicit as keyof typeof REVIEW_PORTS;
  }
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_EFFORT) return "claude";
  if (env.CODEX_THREAD_ID) return "codex";
  return "standalone";
}

export function reviewPort(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): number {
  const port = Number(env.WELLACTUALLY_REVIEW_PORT ?? REVIEW_PORTS[reviewHost(env, argv)]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid findings server port");
  return port;
}

/** Claude's plugin-hosted cards cannot refresh or save votes. Use the inbox. */
export function reviewCardsEnabled(): boolean {
  return reviewHost() !== "claude";
}

export const UI_PORT = reviewPort();
