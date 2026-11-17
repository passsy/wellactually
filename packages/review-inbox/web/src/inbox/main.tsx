import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./App.tsx";
import "../styles/inbox.css";

/**
 * Nothing is refetched because time passed.
 *
 * The server pushes a change event whenever anything under a watched review
 * directory is written, which covers this page's own writes and an agent's
 * alike, so every refetch is because something happened. A tab in the
 * background asks on a timer instead of holding a stream open — see
 * useLive — but it too only refetches when the answer says something moved.
 */
const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

/**
 * The worker that gives this page a window of its own.
 *
 * Registered after mount rather than before, because it is what makes the
 * page installable and offline-aware, and neither is a reason to delay the
 * queue. It caches nothing — a refresh always shows the new page — so the
 * only thing it changes for a reader who never installs it is nothing.
 */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker?.register("/sw.js").catch(() => {
    // A page served from a file or an origin the browser will not register
    // a worker for still works. It just cannot be installed.
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("no #root to mount the inbox into");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      {/*
        One provider so every tooltip on the page shares a delay: the first
        hover waits, moving between controls does not — the way every native
        toolbar behaves.
      */}
      <TooltipProvider delayDuration={350}>
        <App />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
