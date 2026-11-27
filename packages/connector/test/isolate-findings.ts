// Each test file gets its own registry, including child MCP processes. Fixtures
// must never leak into the user's inbox or collide with another file's fixtures.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
const registry=fs.mkdtempSync(path.join(os.tmpdir(),"wa-test-registry-"));
process.env.WELLACTUALLY_REVIEW_INBOX_HOME=registry;
process.env.WELLACTUALLY_HOME=path.join(registry,"advice");
// Codex hooks are written to CODEX_HOME: never the user's own.
process.env.CODEX_HOME=path.join(registry,"codex");
afterAll(()=>fs.rmSync(registry,{recursive:true,force:true}));
// The agent running the tests must not decide the review host, its port or the rater's transcripts.
// A test that needs a host sets WELLACTUALLY_REVIEW_HOST itself.
for (const name of ["CLAUDECODE","CLAUDE_CODE_ENTRYPOINT","CLAUDE_CODE_SESSION_ID","CLAUDE_EFFORT","CLAUDE_PLUGIN_ROOT","CODEX_THREAD_ID","WELLACTUALLY_REVIEW_HOST","WELLACTUALLY_REVIEW_PORT"]) delete process.env[name];
