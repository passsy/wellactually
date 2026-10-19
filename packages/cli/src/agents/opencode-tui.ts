import { pluginRoot, updateNoticeFor } from "./bridge.ts";

/**
 * The CLI plugin of OpenCode 2, which OpenCode loads from the package's
 * `./tui` export next to the server plugin. Only it can show a toast. It
 * tells the user once when a newer release of the plugin is out.
 */

/** The part of OpenCode 2's CLI plugin context this plugin uses. */
interface TuiContext {
  ui: { toast: { show(toast: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number }): void } };
}

function setup(context: TuiContext): void {
  // Not awaited, so the terminal does not wait for the command to start.
  void updateNoticeFor("opencode", pluginRoot()).then((text) => {
    if (text !== "") {
      context.ui.toast.show({ title: "Well Actually", message: text, variant: "info", duration: 10_000 });
    }
  });
}

export default { id: "wellactually", setup };
