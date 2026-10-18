/**
 * Reads advice text the way a suspicious reviewer would.
 *
 * A principle's job is to put text in front of an agent, so the advice is the
 * one part of a principle no sandbox contains. This scan does not decide
 * anything. It lists what a human should look at before releasing a version
 * or accepting an update.
 */

interface Signal {
  pattern: RegExp;
  warning: string;
}

const SIGNALS: Signal[] = [
  {
    pattern: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|system)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?)\b/i,
    warning: "tells the reader to ignore other instructions",
  },
  {
    pattern: /\b(curl|wget|nc|ncat|scp|ssh)\b[^\n]*\bhttps?:\/\/|\|\s*(sh|bash|zsh)\b/i,
    warning: "contains a command that talks to the network or pipes into a shell",
  },
  {
    pattern: /(~\/\.ssh|\.aws\/credentials|\.netrc|\bid_rsa\b|\.env\b|\bkeychain\b)/i,
    warning: "mentions credential files",
  },
  {
    pattern: /\b(api[_ -]?key|access[_ -]?token|secret|password)s?\b[^.\n]{0,60}\b(send|post|upload|share|paste|include|print|echo)\b|\b(send|post|upload|share|paste|print|echo)\b[^.\n]{0,60}\b(api[_ -]?key|access[_ -]?token|secret|password)s?\b/i,
    warning: "asks for secrets to be sent or printed",
  },
  {
    pattern: /\b(do not|don't|never)\b[^.\n]{0,30}\b(tell|mention|inform|show)\b[^.\n]{0,30}\b(user|human|developer)\b/i,
    warning: "asks the reader to hide something from the user",
  },
  {
    pattern: /\b(you must|always)\b[^.\n]{0,20}\b(run|execute)\b/i,
    warning: "orders the reader to run something",
  },
  {
    pattern: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/,
    warning: "contains invisible characters",
  },
];

/** Warnings for a human reviewer. An empty list means nothing stood out, not that the text is safe. */
export function scanAdvice(advice: string): string[] {
  const warnings: string[] = [];
  for (const signal of SIGNALS) {
    const match = signal.pattern.exec(advice);
    if (!match) {
      continue;
    }
    const excerpt = match[0].replace(/\s+/g, " ").trim().slice(0, 80);
    warnings.push(`The advice ${signal.warning}: "${excerpt}"`);
  }

  const hosts = new Set<string>();
  for (const url of advice.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    hosts.add((url[1] ?? "").toLowerCase());
  }
  if (hosts.size > 0) {
    warnings.push(`The advice links to ${[...hosts].sort().join(", ")}`);
  }
  return warnings;
}
