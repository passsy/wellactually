/**
 * What an installed window shows when no server is up.
 *
 * This is the screen the app spends its worst moments on, so it does the work
 * rather than reporting a failure: it says why nothing is there, gives the
 * command that fixes it ready to paste, and watches the port so that starting
 * a server anywhere brings the window back without anyone pressing anything.
 *
 * Rendered to markup when the service worker is generated, and inlined into
 * it. Everything it needs is in the file, because it is shown precisely when
 * the thing that would serve anything else is missing.
 */

export interface OfflineData {
  /** The command that starts this very build, ready to paste. */
  command: string;
  /** Which plugin last served the page. */
  host: string;
  port: number;
}

export function Offline({ data }: { data: OfflineData }) {
  return (
    <main>
      <h1>The Review Inbox is not running</h1>
      <p>
        Your reviews are on disk and none of this loses them. Nothing is serving
        them right now.
      </p>
      <p>It was last served by the {data.host} plugin.</p>

      <h2>Start it</h2>
      <div className="cmd">
        <code id="cmd">{data.command}</code>
        <button id="copy" type="button">
          Copy
        </button>
      </div>
      <p>
        That serves the page on its own, without the review tools. It keeps
        running until you stop it.
      </p>

      <h2>Or start a session</h2>
      <p>
        The server normally belongs to a {data.host} session and ends with it,
        so opening one in any reviewed project brings the page back with the
        tools attached.
      </p>
      <p>
        Either plugin can serve this page, and they read the same reviews.
        Whichever starts first takes the port.
      </p>

      <p className="watch">
        <span className="dot" />
        Watching port {data.port}. This window comes back on its own.
      </p>
    </main>
  );
}
