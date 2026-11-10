import path from "node:path";
import { boardHome } from "../board/board.ts";
import { logHookFailure, runHook } from "./hook.ts";
import { type HookLogEntry, scheduleHookLog } from "./hook-log.ts";

/** Shared by the CLI and the separately trusted hook executable. */
export async function handleHook(): Promise<void> {
  const started = performance.now();
  const log: HookLogEntry = {time:new Date().toISOString(),hook:"",events:[],shown:0,ms:0};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const out = await runHook(Buffer.concat(chunks).toString("utf8"), log);
    if (out) console.log(out);
    log.shown = out.length;
  } catch (error) {
    logHookFailure(error);
    log.note = `failed: ${(error as Error).message}`;
    console.error(`wellactually hook failed, see ~/.wellactually/hook.log: ${(error as Error).message}`);
  }
  log.ms = Math.round(performance.now() - started);
  if (process.env.WELLACTUALLY_HOOK_LOG !== "0") scheduleHookLog(path.join(boardHome(),"logs"), log);
}
