import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);

// packages/cli/src/hook-log.ts
import fs from "node:fs";
import path from "node:path";
var LOG_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var LOG_MAX_FILE_BYTES = 2 * 1024 * 1024;
function writeHookLog(dir2, line, now = /* @__PURE__ */ new Date()) {
  fs.mkdirSync(dir2, { recursive: true });
  for (const name of fs.readdirSync(dir2)) {
    if (!/^hooks-.*\.jsonl$/.test(name)) {
      continue;
    }
    const file2 = path.join(dir2, name);
    try {
      if (now.getTime() - fs.statSync(file2).mtimeMs > LOG_MAX_AGE_MS) {
        fs.rmSync(file2, { force: true });
      }
    } catch {
    }
  }
  const file = path.join(dir2, `hooks-${now.toISOString().slice(0, 13)}.jsonl`);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
  }
  const text = line.endsWith("\n") ? line : `${line}
`;
  if (size + Buffer.byteLength(text) > LOG_MAX_FILE_BYTES) {
    return;
  }
  fs.appendFileSync(file, text);
}
async function writeHookLogFromStdin(dir2) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const line = Buffer.concat(chunks).toString("utf8").trim();
  if (line) {
    writeHookLog(dir2, line);
  }
}

// packages/cli/src/log-writer.ts
var dir = process.argv[2];
if (dir) {
  writeHookLogFromStdin(dir).catch(() => {
  });
}
