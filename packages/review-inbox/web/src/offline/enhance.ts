/**
 * The two things the offline page does once it is on screen.
 *
 * No React here, for the same reason the report has none: this is inlined
 * into a service worker, and a hydration bundle would be half a megabyte
 * shipped to say two sentences and poll a port.
 */

import "./offline.css";

const command = document.getElementById("cmd");
const copy = document.getElementById("copy");

copy?.addEventListener("click", () => {
  void navigator.clipboard.writeText(command?.textContent ?? "").then(() => {
    copy.textContent = "Copied";
    setTimeout(() => {
      copy.textContent = "Copy";
    }, 1400);
  });
});

/**
 * A plain fetch, so it goes to the network rather than through the worker
 * that is showing this page.
 *
 * The moment something answers, this stops being the right thing to look at.
 */
setInterval(() => {
  void fetch("/api/health", { cache: "no-store" })
    .then((response) => {
      if (response.ok) location.reload();
    })
    .catch(() => {
      // Still nothing listening, which is what this page is for.
    });
}, 2000);
