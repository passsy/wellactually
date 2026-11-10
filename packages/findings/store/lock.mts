import fs from "node:fs";
import path from "node:path";
import { InputError } from "../validate.mts";

/** Serialize read/modify/write across MCP processes; recover only dead owners. */
export function locked<T>(dir: string, action: () => T): T {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".lock");
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner"), String(process.pid));
      break;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const recovery = path.join(dir, ".recovery");
      let ownsRecovery = false;
      try {
        fs.mkdirSync(recovery);
        ownsRecovery = true;
        const pid = Number(fs.readFileSync(path.join(lock, "owner"), "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (failure: any) {
            if (failure.code === "ESRCH")
              fs.rmSync(lock, { recursive: true, force: true });
          }
        }
      } catch {
        if (ownsRecovery) {
          try {
            if (
              Date.now() - fs.statSync(lock).mtimeMs > 60_000 &&
              !fs.existsSync(path.join(lock, "owner"))
            )
              fs.rmSync(lock, { recursive: true, force: true });
          } catch {
            /* Owner released between reads. */
          }
        }
      } finally {
        if (ownsRecovery) fs.rmSync(recovery, { recursive: true, force: true });
      }
      if (Date.now() - start > 5000)
        throw new InputError("Records are busy; retry this call");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
