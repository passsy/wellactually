import { useEffect, useRef, useState } from "react";
import type {
  FindingRecord,
  OccurrenceRecord,
  OccurrenceSummary,
} from "../../../model/records.mts";
import { Markdown } from "./markdown/Markdown.tsx";
import { Chunk, type ChunkAt } from "./chunk/Chunk.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  RotateCcw,
  LoaderCircle,
} from "lucide-react";

export function FindingInformation({ record }: { record: FindingRecord }) {
  return (
    <>
      {record.closure && (
        <p role="note">
          Closed · {record.closure.reason}: {record.closure.explanation}
          {record.closure.supersededBy?.length
            ? ` → ${record.closure.supersededBy.join(", ")}`
            : ""}
        </p>
      )}
      {record.links.length > 0 && (
        <ul className="my-3 text-sm">
          {record.links.map((l) => (
            <li key={l.id}>
              {l.kind}:{" "}
              {l.url ? (
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {l.description ?? l.url}
                </a>
              ) : (
                <code>{l.commit}</code>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
function Occurrence({
  occurrence,
  onOpen,
  onChange,
  save,
}: {
  occurrence: OccurrenceRecord;
  onOpen?: ((at: ChunkAt) => void) | undefined;
  onChange: () => void;
  save?: ((occurrence: OccurrenceRecord) => Promise<void>) | undefined;
}) {
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null);
  return (
    <div>
      {save && (
        <div className="mt-2 flex items-center justify-end gap-2">
          {occurrence.state === "closed" &&
            occurrence.closure?.reason !== "resolved" && (
              <span className="text-xs text-muted">
                Closed · {occurrence.closure?.reason}
              </span>
            )}
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label={
              occurrence.state === "open"
                ? "Mark occurrence resolved"
                : "Reopen occurrence"
            }
            aria-pressed={occurrence.closure?.reason === "resolved"}
            title={
              occurrence.state === "open"
                ? "Mark this occurrence resolved"
                : "Reopen this occurrence"
            }
            className={
              occurrence.closure?.reason === "resolved"
                ? "border-done/40 bg-done/10 text-done hover:bg-done/20"
                : ""
            }
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setError(null);
              void save(occurrence)
                .then(onChange)
                .catch((why: unknown) =>
                  setError(why instanceof Error ? why.message : String(why)),
                )
                .finally(() => setSaving(false));
            }}
          >
            {saving ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : occurrence.closure?.reason === "resolved" ? (
              <CircleCheck aria-hidden="true" />
            ) : occurrence.state === "closed" ? (
              <RotateCcw aria-hidden="true" />
            ) : (
              <Circle aria-hidden="true" />
            )}

          </Button>
        </div>
      )}
      {error && <p role="alert">Could not save occurrence: {error}</p>}
      {occurrence.description && <Markdown body={occurrence.description} />}
      {occurrence.closure && <Markdown body={occurrence.closure.explanation} />}
      {occurrence.locations.map((location, i) =>
        location.context?.lines.length ? (
          <Chunk key={i} at={location} onOpen={onOpen} withDiff={false} />
        ) : (
          <div key={i} className="my-3 rounded border border-line p-3">
            <button
              type="button"
              className="font-mono text-xs underline"
              disabled={!onOpen}
              onClick={() => onOpen?.(location)}
            >
              {location.file}:{location.line}
            </button>
            <p role="note" className="text-sm text-muted">
              Source code was not captured for this location.
            </p>
            <Chunk at={location} onOpen={onOpen} />
          </div>
        ),
      )}
      {occurrence.links.map((l) => (
        <p key={l.id}>
          {l.kind}:{" "}
          {l.url ? (
            <a href={l.url} target="_blank" rel="noreferrer">
              {l.description ?? l.url}
            </a>
          ) : (
            <code>{l.commit}</code>
          )}
        </p>
      ))}
    </div>
  );
}
export function Occurrences({
  findingId,
  summary,
  refreshKey,
  load,
  save,
  onOpen,
}: {
  findingId: string;
  summary?: OccurrenceSummary | undefined;
  refreshKey: string;
  load: () => Promise<OccurrenceRecord[]>;
  save?: ((occurrence: OccurrenceRecord) => Promise<void>) | undefined;
  onOpen?: ((at: ChunkAt) => void) | undefined;
}) {
  const [loaded, setLoaded] = useState<{
      findingId: string;
      items: OccurrenceRecord[];
    } | null>(null),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [retry, setRetry] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    let active = true;
    setError(null);
    void loader.current().then(
      (next) => {
        if (active) {
          setLoaded({ findingId, items: next });
          setError(null);
        }
      },
      (why: unknown) => {
        if (active) setError(why instanceof Error ? why.message : String(why));
      },
    );
    return () => {
      active = false;
    };
  }, [findingId, refreshKey, retry]);
  const items = loaded?.findingId === findingId ? loaded.items : null;
  const total = items?.length ?? summary?.total ?? 0;
  const resolved =
    items?.filter((o) => o.closure?.reason === "resolved").length ??
    summary?.resolved ??
    0;
  const index = Math.max(0, items?.findIndex((o) => o.id === selectedId) ?? 0);
  const current = items?.[index];
  return (
    <section aria-label="Occurrences" className="my-4">
      {total > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              Occurrence {index + 1} of {total}
            </span>
            <span className="text-muted">
              {resolved} of {total} resolved
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              type="button"
              aria-label="Previous occurrence"
              title="Previous occurrence"
              disabled={!items || index === 0}
              onClick={() => setSelectedId(items?.[index - 1]?.id ?? null)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              type="button"
              aria-label="Next occurrence"
              title="Next occurrence"
              disabled={!items || index >= items.length - 1}
              onClick={() => setSelectedId(items?.[index + 1]?.id ?? null)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
      {error ? (
        <p role="alert">
          Could not load occurrences: {error}{" "}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </p>
      ) : items === null ? (
        <p role="status">Loading code…</p>
      ) : current ? (
        <Occurrence
          key={current.id}
          occurrence={current}
          save={total > 1 ? save : undefined}
          onOpen={onOpen}
          onChange={() => setRetry((n) => n + 1)}
        />
      ) : (
        <p role="note">No source locations recorded for this finding.</p>
      )}
    </section>
  );
}
