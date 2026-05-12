"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  listMissions,
  getMission,
  listMemory,
  startMission,
  streamUrl,
  type MissionSummary,
  type Mission,
  type MissionEvent,
  type MemoryDoc,
} from "@/lib/api";
import {
  buildHighlighter,
  collectMentionedIds,
  splitHighlights,
  type Highlighter,
} from "@/lib/highlight";

type ToolCallPayload = { name: string; args: Record<string, unknown> };
type ToolResultPayload = { name: string; result: unknown };
type ReasoningPayload = { turn?: number; text: string };
type ReasoningDeltaPayload = { block_id: string; turn?: number; text: string };

type ToolCategory = "memory" | "commerce" | "analytics";
const TOOL_CATEGORY: Record<string, ToolCategory> = {
  recall_similar_launches: "memory",
  save_mission_outcome: "memory",
  publish_to_shopify: "commerce",
};
const CATEGORY_COLOR: Record<ToolCategory, { dot: string; label: string }> = {
  memory: { dot: "bg-[var(--memory)]", label: "text-[var(--memory)]" },
  commerce: { dot: "bg-emerald-400", label: "text-emerald-400" },
  analytics: { dot: "bg-amber-400", label: "text-amber-400" },
};

// Display-only stale threshold for missions stuck in "running" — used to avoid
// stale teal dots polluting the sidebar during a demo.
const STALE_MISSION_MS = 10 * 60 * 1000;

type RenderItem =
  | { kind: "mission_start"; at: string }
  | { kind: "reasoning"; at: string; text: string; streaming?: boolean }
  | {
      kind: "tool_call";
      at: string;
      name: string;
      args: Record<string, unknown>;
    }
  | { kind: "tool_result"; at: string; name: string; result: unknown }
  | { kind: "mission_complete"; at: string };

function collapseEvents(events: MissionEvent[]): RenderItem[] {
  const out: RenderItem[] = [];
  const blockIndex = new Map<string, number>();

  for (const ev of events) {
    if (ev.kind === "reasoning_delta") {
      const p = ev.payload as ReasoningDeltaPayload;
      const idx = blockIndex.get(p.block_id);
      const item: RenderItem = {
        kind: "reasoning",
        at: ev.at,
        text: p.text,
        streaming: true,
      };
      if (idx === undefined) {
        blockIndex.set(p.block_id, out.length);
        out.push(item);
      } else {
        out[idx] = item;
      }
    } else if (ev.kind === "reasoning") {
      const p = ev.payload as ReasoningPayload;
      out.push({ kind: "reasoning", at: ev.at, text: p.text });
    } else if (ev.kind === "tool_call") {
      const p = ev.payload as ToolCallPayload;
      out.push({ kind: "tool_call", at: ev.at, name: p.name, args: p.args });
    } else if (ev.kind === "tool_result") {
      const p = ev.payload as ToolResultPayload;
      out.push({ kind: "tool_result", at: ev.at, name: p.name, result: p.result });
    } else if (ev.kind === "mission_start") {
      out.push({ kind: "mission_start", at: ev.at });
    } else if (ev.kind === "mission_complete") {
      out.push({ kind: "mission_complete", at: ev.at });
    }
  }
  return out;
}

export default function MissionControl() {
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mission, setMission] = useState<Mission | null>(null);
  const [memory, setMemory] = useState<MemoryDoc[]>([]);
  const [brief, setBrief] = useState("");
  const [starting, setStarting] = useState(false);
  const [hoveredMemoryId, setHoveredMemoryId] = useState<string | null>(null);
  // Map of memoryId → mount key (ts). Bumping the key remounts the card with
  // the pulse animation re-fired. We clear entries 1.2s after mount.
  const [pulses, setPulses] = useState<Record<string, number>>({});
  const evtRef = useRef<EventSource | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const seenMentionsRef = useRef<Set<string>>(new Set());
  // Stale-mission ticker: refreshes "now" every 30s so the sidebar can age
  // running dots into "stalled" without waiting for another fetch. Held in
  // state (not derived from Date.now() at render) to satisfy purity rules.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const refreshMissions = useCallback(async () => {
    try {
      setMissions(await listMissions());
    } catch (e) {
      console.error(e);
    }
  }, []);

  const refreshMemory = useCallback(async () => {
    try {
      setMemory(await listMemory());
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    // Initial fetch: setState happens in the .then callback (subscription
    // pattern), not synchronously in the effect body.
    listMissions().then(setMissions).catch(console.error);
    listMemory().then(setMemory).catch(console.error);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;

    // Reset per-mission state so previous mission's highlights/pulses don't
    // contaminate the new one. setState here is intentional — selectedId acts
    // as the reset key for this synchronization effect.
    seenMentionsRef.current = new Set();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPulses({});
    setHoveredMemoryId(null);

    (async () => {
      try {
        const full = await getMission(selectedId);
        if (!cancelled) setMission(full);
      } catch (e) {
        console.error(e);
      }
    })();

    evtRef.current?.close();
    const es = new EventSource(streamUrl(selectedId));
    evtRef.current = es;

    const appendEvent = (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(ev.data) as MissionEvent;
        setMission((cur) => {
          if (!cur) return cur;
          const dup = cur.events.some(
            (e) =>
              e.kind === parsed.kind &&
              e.at === parsed.at &&
              JSON.stringify(e.payload) === JSON.stringify(parsed.payload),
          );
          if (dup) return cur;
          return { ...cur, events: [...cur.events, parsed] };
        });
      } catch (e) {
        console.error("parse SSE", e, ev.data);
      }
    };

    es.addEventListener("mission_start", appendEvent);
    es.addEventListener("reasoning", appendEvent);
    es.addEventListener("reasoning_delta", appendEvent);
    es.addEventListener("tool_call", appendEvent);
    es.addEventListener("tool_result", appendEvent);
    es.addEventListener("mission_complete", (ev) => {
      appendEvent(ev);
      setMission((cur) => (cur ? { ...cur, status: "complete" } : cur));
      refreshMissions();
      refreshMemory();
    });
    es.addEventListener("done", () => es.close());
    es.onerror = () => {
      /* backend closes the stream after done; not fatal */
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, [selectedId, refreshMissions, refreshMemory]);

  const onStart = useCallback(async () => {
    const b = brief.trim();
    if (!b) return;
    setStarting(true);
    try {
      const { mission_id } = await startMission(b);
      setBrief("");
      setSelectedId(mission_id);
      setMission({ _id: mission_id, brief: b, status: "running", events: [] });
      await refreshMissions();
    } catch (e) {
      console.error(e);
    } finally {
      setStarting(false);
    }
  }, [brief, refreshMissions]);

  const retrieved = useMemo<MemoryDoc[]>(() => {
    if (!mission) return [];
    const last = [...mission.events]
      .reverse()
      .find(
        (e) =>
          e.kind === "tool_result" &&
          (e.payload as ToolResultPayload).name === "recall_similar_launches",
      );
    if (!last) return [];
    const result = (last.payload as ToolResultPayload).result;
    return Array.isArray(result) ? (result as MemoryDoc[]) : [];
  }, [mission]);

  // The highlighter is built from the memory cards visible on the right. We
  // fall back to the full memory list before the agent has recalled anything
  // so that early reasoning still gets highlighted if it happens to mention a
  // known launch (rare, but cheap to support).
  const highlighter = useMemo<Highlighter | null>(
    () => buildHighlighter(retrieved.length > 0 ? retrieved : memory),
    [retrieved, memory],
  );

  const shopify = useMemo(() => {
    if (!mission) return null;
    const ev = [...mission.events]
      .reverse()
      .find(
        (e) =>
          e.kind === "tool_result" &&
          (e.payload as ToolResultPayload).name === "publish_to_shopify",
      );
    if (!ev) return null;
    return (ev.payload as ToolResultPayload).result as {
      product_id?: number;
      handle?: string;
      admin_url?: string;
      error?: string;
    };
  }, [mission]);

  const renderItems = useMemo(
    () => (mission ? collapseEvents(mission.events) : []),
    [mission],
  );

  // After each render of the timeline, detect any memory ids newly mentioned
  // in reasoning text and fire a 1.2s pulse on the corresponding cards.
  useEffect(() => {
    if (!highlighter) return;
    const fresh: string[] = [];
    for (const item of renderItems) {
      if (item.kind !== "reasoning" || !item.text) continue;
      for (const id of collectMentionedIds(item.text, highlighter)) {
        if (!seenMentionsRef.current.has(id)) {
          seenMentionsRef.current.add(id);
          fresh.push(id);
        }
      }
    }
    if (fresh.length === 0) return;
    const now = Date.now();
    // Marking newly mentioned memory ids for the 1.2s pulse animation is a
    // legitimate derived-from-stream side effect, not avoidable via useMemo
    // because it triggers wall-clock timers.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPulses((cur) => {
      const next = { ...cur };
      for (const id of fresh) next[id] = now;
      return next;
    });
    const timers = fresh.map((id) =>
      window.setTimeout(() => {
        setPulses((cur) => {
          if (cur[id] !== now) return cur; // a newer pulse won
          const next = { ...cur };
          delete next[id];
          return next;
        });
      }, 1200),
    );
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [renderItems, highlighter]);

  // auto-scroll timeline as new items arrive
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 250;
    if (nearBottom || mission?.status === "running") {
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      });
    }
  }, [renderItems.length, mission?.status, renderItems]);

  const metrics = useMemo(() => {
    const complete = missions.filter((m) => m.status === "complete");
    const totalDur = complete.reduce((s, m) => s + (m.duration_s ?? 0), 0);
    const avg = complete.length ? totalDur / complete.length : 0;
    return {
      total: missions.length,
      complete: complete.length,
      avg,
      memory: memory.length,
    };
  }, [missions, memory]);

  const onHoverMemory = useCallback((id: string | null) => {
    setHoveredMemoryId(id);
  }, []);

  return (
    <div className="grid h-screen grid-cols-[280px_1fr_400px] bg-[var(--bg-0)] text-[var(--fg)]">
      {/* LEFT SIDEBAR */}
      <aside className="flex h-screen flex-col border-r border-[var(--border)] bg-[var(--bg-1)]">
        <div className="border-b border-[var(--border)] px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="h-2.5 w-2.5 rounded-full bg-[var(--accent)] shadow-[0_0_8px_var(--accent)]" />
            <div className="font-semibold tracking-tight">Helix</div>
            <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-[var(--fg-dim)]">
              v0.1
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-[var(--fg-muted)]">
            Autonomous commerce ops with persistent memory
          </p>
        </div>

        <div className="flex items-center justify-between px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-[var(--fg-dim)]">
          <span>Missions</span>
          <span>{missions.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {missions.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-[var(--fg-dim)]">
              No missions yet. Start one →
            </div>
          )}
          <ul className="space-y-1">
            {missions.map((m) => (
              <li key={m._id}>
                <MissionListItem
                  mission={m}
                  active={m._id === selectedId}
                  nowMs={nowMs}
                  onSelect={() => setSelectedId(m._id)}
                />
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* CENTER — TIMELINE */}
      <main className="flex h-screen flex-col">
        <div className="grid grid-cols-4 border-b border-[var(--border)] bg-[var(--bg-1)]">
          <Metric label="Missions Run" value={String(metrics.total)} />
          <Metric label="Completed" value={String(metrics.complete)} />
          <Metric
            label="Avg Duration"
            value={metrics.avg ? `${metrics.avg.toFixed(1)}s` : "—"}
          />
          <Metric label="Memory Entries" value={String(metrics.memory)} />
        </div>

        <div className="border-b border-[var(--border)] bg-[var(--bg-1)] px-8 py-5">
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--fg-dim)]">
            New mission
          </div>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onStart();
              }}
              placeholder="Describe a product to launch…  (e.g. Portable RGB Desk Lamp)"
              className="flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-0)] px-3 py-2 text-sm text-[var(--fg)] placeholder:text-[var(--fg-dim)] focus:border-[var(--accent-dim)] focus:outline-none"
            />
            <button
              onClick={() => void onStart()}
              disabled={starting || !brief.trim()}
              className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg-0)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-[var(--bg-3)] disabled:text-[var(--fg-dim)]"
            >
              {starting ? "Starting…" : "Run mission"}
            </button>
          </div>
        </div>

        <div ref={timelineRef} className="flex-1 overflow-y-auto px-8 py-6">
          {!mission && (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--fg-dim)]">
                  Mission Control
                </div>
                <div className="mt-2 text-lg text-[var(--fg-muted)]">
                  Awaiting first mission.
                </div>
              </div>
            </div>
          )}

          {mission && (
            <>
              <div className="mb-6">
                <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--fg-dim)]">
                  Vertex Agent Mission
                </div>
                <div className="mt-1 text-xl font-semibold tracking-tight">
                  {mission.brief}
                </div>
                <div className="mt-1 flex items-center gap-3 font-mono text-[10px] text-[var(--fg-dim)]">
                  <span>{mission._id}</span>
                  {mission.status === "running" && (
                    <span className="flex items-center gap-1 text-[var(--accent)]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)] pulse-soft" />
                      running
                    </span>
                  )}
                  {mission.status === "complete" && (
                    <span className="text-[var(--fg-muted)]">
                      complete
                      {mission.duration_s ? ` · ${mission.duration_s.toFixed(1)}s` : ""}
                    </span>
                  )}
                </div>
              </div>

              <ol className="relative space-y-3 border-l border-[var(--border)] pl-6">
                {renderItems.map((item, i) => (
                  <TimelineRow
                    key={`${item.kind}-${i}`}
                    item={item}
                    highlighter={highlighter}
                    hoveredMemoryId={hoveredMemoryId}
                    onHoverMemory={onHoverMemory}
                  />
                ))}
                {mission.status === "running" && (
                  <li className="relative -ml-6 flex items-center gap-3 pl-6">
                    <span className="absolute left-0 top-1 h-2 w-2 -translate-x-1 rounded-full bg-[var(--accent)] pulse-soft" />
                    <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--accent)]">
                      thinking…
                    </span>
                  </li>
                )}
              </ol>
            </>
          )}
        </div>
      </main>

      {/* RIGHT — CONTEXT */}
      <aside className="flex h-screen flex-col border-l border-[var(--border)] bg-[var(--bg-1)]">
        <div className="border-b border-[var(--border)] px-5 py-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--fg-dim)]">
            Operational Memory
          </div>
          <div className="mt-1 text-sm text-[var(--fg-muted)]">
            MongoDB Atlas · vector search
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {retrieved.length > 0 ? (
            <>
              <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
                Retrieved this mission
              </div>
              <ul className="space-y-2">
                {retrieved.map((doc) => (
                  <MemoryCard
                    key={doc._id}
                    doc={doc}
                    score={(doc as MemoryDoc & { score?: number }).score}
                    highlight
                    isHovered={hoveredMemoryId === doc._id}
                    pulseKey={pulses[doc._id]}
                    onHoverEnter={() => onHoverMemory(doc._id)}
                    onHoverLeave={() => onHoverMemory(null)}
                  />
                ))}
              </ul>
            </>
          ) : (
            <>
              <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
                Memory ({memory.length})
              </div>
              {memory.length === 0 ? (
                <div className="px-1 py-4 text-center text-xs text-[var(--fg-dim)]">
                  No memory yet.
                </div>
              ) : (
                <ul className="space-y-2">
                  {memory.slice(0, 8).map((doc) => (
                    <MemoryCard
                      key={doc._id}
                      doc={doc}
                      isHovered={hoveredMemoryId === doc._id}
                      pulseKey={pulses[doc._id]}
                      onHoverEnter={() => onHoverMemory(doc._id)}
                      onHoverLeave={() => onHoverMemory(null)}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {shopify && (
          <div className="border-t border-[var(--border)] bg-[var(--bg-2)] px-5 py-4 fade-in-up">
            <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--fg-dim)]">
              Published to Shopify
            </div>
            {shopify.error ? (
              <div className="mt-2 text-sm text-[var(--danger)]">
                {shopify.error}
              </div>
            ) : (
              <>
                <div className="mt-1 text-sm font-medium text-[var(--fg)]">
                  {shopify.handle}
                </div>
                <div className="font-mono text-[10px] text-[var(--fg-dim)]">
                  product_id: {shopify.product_id}
                </div>
                {shopify.admin_url && (
                  <a
                    href={shopify.admin_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-xs text-[var(--accent)] hover:underline"
                  >
                    Open in Shopify admin →
                  </a>
                )}
              </>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-r border-[var(--border)] px-5 py-3 last:border-r-0">
      <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--fg-dim)]">
        {label}
      </div>
      <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-[var(--fg)]">
        {value}
      </div>
    </div>
  );
}

function MissionListItem({
  mission,
  active,
  nowMs,
  onSelect,
}: {
  mission: MissionSummary;
  active: boolean;
  nowMs: number;
  onSelect: () => void;
}) {
  const stale = useMemo(() => {
    if (mission.status !== "running" || !mission.started_at) return false;
    const startedMs = Date.parse(mission.started_at);
    if (Number.isNaN(startedMs)) return false;
    return nowMs - startedMs > STALE_MISSION_MS;
  }, [mission.status, mission.started_at, nowMs]);

  const running = mission.status === "running" && !stale;
  const complete = mission.status === "complete";

  const dotClass = stale
    ? "bg-[var(--warn)]"
    : running
      ? "bg-[var(--accent)] pulse-soft"
      : complete
        ? "bg-[var(--fg-dim)]"
        : "bg-[var(--warn)]";

  return (
    <button
      onClick={onSelect}
      className={`w-full rounded-md border px-3 py-2 text-left transition ${
        active
          ? "border-[var(--border)] bg-[var(--bg-2)]"
          : "border-transparent hover:border-[var(--border-soft)] hover:bg-[var(--bg-2)]"
      }`}
    >
      <div className="flex items-center gap-2">
        <div className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
        <div className="truncate text-[13px] font-medium">{mission.brief}</div>
        {stale && (
          <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-widest text-[var(--warn)]">
            stalled
          </span>
        )}
      </div>
      <div className="ml-3.5 mt-0.5 truncate font-mono text-[10px] text-[var(--fg-dim)]">
        {mission._id}
      </div>
    </button>
  );
}

function TimelineRow({
  item,
  highlighter,
  hoveredMemoryId,
  onHoverMemory,
}: {
  item: RenderItem;
  highlighter: Highlighter | null;
  hoveredMemoryId: string | null;
  onHoverMemory: (id: string | null) => void;
}) {
  const time = item.at ? new Date(item.at).toLocaleTimeString() : "";

  if (item.kind === "mission_start") {
    return (
      <li className="relative fade-in-up">
        <span className="absolute -left-[1.55rem] top-1.5 h-2 w-2 rounded-full bg-[var(--fg-muted)]" />
        <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--fg-dim)]">
          Mission started · {time}
        </div>
      </li>
    );
  }

  if (item.kind === "mission_complete") {
    return (
      <li className="relative fade-in-up">
        <span className="absolute -left-[1.55rem] top-1.5 h-2 w-2 rounded-full bg-[var(--fg-muted)]" />
        <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
          Mission complete · {time}
        </div>
      </li>
    );
  }

  if (item.kind === "reasoning") {
    return (
      <li className="relative fade-in-up">
        <span className="absolute -left-[1.55rem] top-1.5 h-2 w-2 rounded-full bg-[var(--accent)] shadow-[0_0_6px_var(--accent)]" />
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-[var(--accent-dim)]">
          <span>Reasoning · {time}</span>
          {item.streaming && (
            <span className="inline-block h-[6px] w-[6px] rounded-full bg-[var(--accent)] pulse-soft" />
          )}
        </div>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-[var(--fg)]">
          <HighlightedText
            text={item.text}
            highlighter={highlighter}
            hoveredMemoryId={hoveredMemoryId}
            onHoverMemory={onHoverMemory}
          />
          {item.streaming && (
            <span className="ml-0.5 inline-block h-[1em] w-[2px] -translate-y-[2px] bg-[var(--accent)] pulse-soft align-middle" />
          )}
        </p>
      </li>
    );
  }

  if (item.kind === "tool_call") {
    const cat = TOOL_CATEGORY[item.name] ?? "analytics";
    const c = CATEGORY_COLOR[cat];
    return (
      <li className="relative fade-in-up">
        <span className={`absolute -left-[1.55rem] top-1.5 h-2 w-2 rounded-full ${c.dot}`} />
        <div className={`font-mono text-[10px] uppercase tracking-widest ${c.label}`}>
          Tool call · {item.name} · {time}
        </div>
        <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-[var(--border-soft)] bg-[var(--bg-1)] p-2 font-mono text-[11px] leading-snug text-[var(--fg-muted)]">
          {JSON.stringify(item.args, null, 2)}
        </pre>
      </li>
    );
  }

  if (item.kind === "tool_result") {
    let summary = "";
    if (Array.isArray(item.result)) {
      summary = `${item.result.length} item${item.result.length === 1 ? "" : "s"}`;
    } else if (item.result && typeof item.result === "object") {
      summary = Object.keys(item.result).join(", ");
    } else {
      summary = String(item.result);
    }
    return (
      <li className="relative fade-in-up">
        <span className="absolute -left-[1.55rem] top-1.5 h-2 w-2 rounded-full bg-[var(--fg-dim)]" />
        <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--fg-dim)]">
          Tool result · {item.name} · {time}
        </div>
        <div className="mt-1 text-xs text-[var(--fg-muted)]">{summary}</div>
      </li>
    );
  }

  return null;
}

function HighlightedText({
  text,
  highlighter,
  hoveredMemoryId,
  onHoverMemory,
}: {
  text: string;
  highlighter: Highlighter | null;
  hoveredMemoryId: string | null;
  onHoverMemory: (id: string | null) => void;
}) {
  const segments = useMemo(
    () => splitHighlights(text, highlighter),
    [text, highlighter],
  );

  if (segments.length === 1 && !segments[0].memoryId) {
    return <>{segments[0].text}</>;
  }

  return (
    <>
      {segments.map((seg, i) => {
        if (!seg.memoryId) {
          return <span key={i}>{seg.text}</span>;
        }
        const active = hoveredMemoryId === seg.memoryId;
        return (
          <span
            key={i}
            className={`mem-mark${active ? " mem-mark-active" : ""}`}
            data-memory-id={seg.memoryId}
            onMouseEnter={() => onHoverMemory(seg.memoryId!)}
            onMouseLeave={() => onHoverMemory(null)}
          >
            {seg.text}
          </span>
        );
      })}
    </>
  );
}

function MemoryCard({
  doc,
  score,
  highlight = false,
  isHovered = false,
  pulseKey,
  onHoverEnter,
  onHoverLeave,
}: {
  doc: MemoryDoc;
  score?: number;
  highlight?: boolean;
  isHovered?: boolean;
  pulseKey?: number;
  onHoverEnter?: (e: MouseEvent<HTMLLIElement>) => void;
  onHoverLeave?: (e: MouseEvent<HTMLLIElement>) => void;
}) {
  const outcomeColor =
    doc.outcome === "blockbuster"
      ? "text-[var(--accent)]"
      : doc.outcome === "strong" || doc.outcome === "solid"
        ? "text-[var(--accent-dim)]"
        : doc.outcome === "underperformed"
          ? "text-[var(--danger)]"
          : "text-[var(--fg-dim)]";

  const baseBorder = highlight
    ? "border-[var(--border)] bg-[var(--bg-2)]"
    : "border-[var(--border-soft)] bg-[var(--bg-1)]";

  return (
    <li
      data-memory-id={doc._id}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      className={`rounded-md border px-3 py-2 transition ${baseBorder} ${
        isHovered ? "mem-card-active" : ""
      } ${pulseKey ? "pulse-once" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="truncate text-[13px] font-medium">{doc.product_name}</div>
        {typeof score === "number" && (
          <span className="shrink-0 font-mono text-[10px] text-[var(--fg-dim)]">
            {score.toFixed(2)}
          </span>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px]">
        {typeof doc.launch_price === "number" && (
          <span className="text-[var(--fg-muted)]">${doc.launch_price.toFixed(2)}</span>
        )}
        {doc.outcome && <span className={outcomeColor}>{doc.outcome}</span>}
      </div>
      {doc.notes && (
        <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-[var(--fg-muted)]">
          {doc.notes}
        </p>
      )}
    </li>
  );
}
