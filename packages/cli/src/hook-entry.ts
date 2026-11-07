// Keep hook trust independent of the MCP server, review helpers and UI bundles.
import { handleHook } from "./hook/command.ts";
import { writeHookLogFromStdin } from "./hook/hook-log.ts";
if (process.argv[2] === "hook-log") await writeHookLogFromStdin(process.argv[3]!);
else await handleHook();
