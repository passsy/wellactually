/**
 * The reader's own note, next to the finding.
 *
 * Inline below the description, before the source occurrences.
 *
 * The note is saved while it is being written rather than submitted, so this
 * is the most frequently hit route on the server. Three things write to the
 * box — moving to another finding, the server answering, and the person
 * typing — and only the last of those may win while a key is down.
 *
 * That was the intent and not the behaviour. The guard came off when a save
 * resolved rather than when the box and the server agreed, so anything typed
 * during the round trip was outside it: the answer to the older save arrived
 * carrying the older text, and the box took it. Characters disappeared, one
 * or two at a time, only while typing quickly — which is the only speed at
 * which it can happen.
 */

import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Textarea } from "@/components/ui/textarea";
import type { Finding } from "../shared/domain.ts";

/** Typing stops for this long and the note is on disk. */
const SETTLE = 600;

export function NoteEditor({
  boxRef,
  finding,
  onSave,
}: {
  /** Handed up so the keyboard's "write a note" can land in the box. */
  boxRef?: RefObject<HTMLTextAreaElement | null>;
  finding: Finding;
  onSave: (id: string, note: string) => Promise<unknown>;
}) {
  const fieldId = useId();
  const [text, setText] = useState(finding.note ?? "");
  const [state, setState] = useState("");
  const editing = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const showing = useRef(finding.id);
  /** The newest thing typed, which is not always the thing being saved. */
  const latest = useRef(text);
  /**
   * The box itself, so this can ask whether the cursor is in it.
   *
   * Kept alongside the ref handed down from the page rather than instead of
   * it: that one is how the keyboard puts the cursor in here, and this one is
   * how the box knows to defend itself.
   */
  const box = useRef<HTMLTextAreaElement | null>(null);

  const fit = (element: HTMLTextAreaElement) => {
    element.style.height = "0px";
    element.style.height = `${Math.max(32, element.scrollHeight + 2)}px`;
  };
  useLayoutEffect(() => {
    if (box.current) fit(box.current);
  }, [text]);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Moving to another finding takes whatever is pending with it, and puts the
  // new finding's note in the box. Coming back to the same finding while it is
  // being typed into must not, which is what `editing` guards.
  useEffect(() => {
    if (showing.current !== finding.id) {
      showing.current = finding.id;
      editing.current = false;
      setText(finding.note ?? "");
      setState("");
      return;
    }
    // Whatever is in the box belongs to whoever is typing in it. The server's
    // copy may only land when there is nothing of theirs outstanding and the
    // cursor is somewhere else — an agent writing a note on the finding you
    // are looking at is worth showing, and never worth a keystroke.
    if (editing.current) return;
    if (box.current !== null && document.activeElement === box.current) return;
    setText(finding.note ?? "");
  }, [finding.id, finding.note]);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  function typed(next: string) {
    editing.current = true;
    latest.current = next;
    setText(next);
    setState("saving…");
    window.clearTimeout(timer.current);
    const id = finding.id;
    timer.current = window.setTimeout(() => {
      void onSave(id, next)
        .then(() => {
          // Only stand down if the box still holds what was just saved. This
          // is where the characters were going: a save takes a round trip,
          // more is typed while it is out, and the answer to the older save
          // came back saying the note was the older text — which then landed
          // back in the box, over the newer keystrokes.
          if (latest.current === next) editing.current = false;
          setState("saved");
        })
        .catch((error: unknown) => {
          setState(error instanceof Error ? error.message : "could not save");
        });
    }, SETTLE);
  }

  return (
    <section aria-label="Your note" data-keeps-panel className="relative">
      <label htmlFor={fieldId} className="sr-only">
        Your note
      </label>
      <Textarea
        id={fieldId}
        ref={(node) => {
          box.current = node;
          if (boxRef) boxRef.current = node;
        }}
        rows={1}
        value={text}
        onChange={(event) => {
          typed(event.target.value);
        }}
        placeholder="Add a note…"
        className="min-h-8 resize-none overflow-hidden rounded-2xl border-line bg-card px-3 py-1 text-sm leading-5"
      />
      {state && (
        <div className="mt-1 flex items-center gap-3">
          <span key={state} className="animate-in fade-in text-xs text-muted">
            {state}
          </span>
        </div>
      )}
    </section>
  );
}
