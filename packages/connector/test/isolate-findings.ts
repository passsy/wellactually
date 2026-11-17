// Each test file gets its own registry, including child MCP processes. Fixtures
// must never leak into the user's inbox or collide with another file's fixtures.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
const registry=fs.mkdtempSync(path.join(os.tmpdir(),"wa-test-registry-"));
process.env.WELLACTUALLY_FINDINGS_HOME=registry;
process.env.WELLACTUALLY_HOME=path.join(registry,"advice");
afterAll(()=>fs.rmSync(registry,{recursive:true,force:true}));
