const BASE = process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8000";

export type EventKind =
  | "mission_start"
  | "reasoning"
  | "reasoning_delta"
  | "tool_call"
  | "tool_result"
  | "mission_complete";

export type MissionEvent = {
  kind: EventKind;
  payload: Record<string, unknown>;
  at: string;
};

export type MissionSummary = {
  _id: string;
  brief: string;
  started_at?: string;
  finished_at?: string;
  duration_s?: number;
  status?: "running" | "complete";
  final_text?: string;
};

export type Mission = MissionSummary & {
  events: MissionEvent[];
};

export type MemoryDoc = {
  _id: string;
  product_name: string;
  category?: string;
  launched_at?: string;
  launch_price?: number;
  outcome?: string;
  notes?: string;
  copy_style?: string;
  shopify_product_id?: number;
};

export async function listMissions(): Promise<MissionSummary[]> {
  const r = await fetch(`${BASE}/api/missions?limit=20`, { cache: "no-store" });
  if (!r.ok) throw new Error(`listMissions ${r.status}`);
  return r.json();
}

export async function getMission(id: string): Promise<Mission> {
  const r = await fetch(`${BASE}/api/missions/${id}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`getMission ${r.status}`);
  const raw = (await r.json()) as Mission & { steps?: LegacyStep[] };
  return { ...raw, events: normalizeEvents(raw) };
}

/**
 * Pre-streaming missions persist a `steps[]` array instead of `events[]`. We
 * fold those into the event timeline so old missions still render. New
 * missions arrive with `events` already populated and pass through untouched.
 */
type LegacyStep = {
  turn?: number;
  type?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  text?: string;
};

function normalizeEvents(raw: { events?: MissionEvent[]; steps?: LegacyStep[]; started_at?: string }): MissionEvent[] {
  if (Array.isArray(raw.events) && raw.events.length > 0) return raw.events;
  if (!Array.isArray(raw.steps)) return [];
  const at = raw.started_at ?? new Date(0).toISOString();
  const out: MissionEvent[] = [];
  for (const s of raw.steps) {
    if (s.type === "reasoning" && typeof s.text === "string") {
      out.push({ kind: "reasoning", payload: { text: s.text, turn: s.turn }, at });
    } else if (s.type === "tool_call" && typeof s.name === "string") {
      out.push({ kind: "tool_call", payload: { name: s.name, args: s.args ?? {} }, at });
      if (s.result !== undefined) {
        out.push({ kind: "tool_result", payload: { name: s.name, result: s.result }, at });
      }
    }
  }
  return out;
}

export async function listMemory(): Promise<MemoryDoc[]> {
  const r = await fetch(`${BASE}/api/memory?limit=20`, { cache: "no-store" });
  if (!r.ok) throw new Error(`listMemory ${r.status}`);
  return r.json();
}

export async function startMission(brief: string): Promise<{ mission_id: string }> {
  const r = await fetch(`${BASE}/api/missions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief }),
  });
  if (!r.ok) throw new Error(`startMission ${r.status}`);
  return r.json();
}

export function streamUrl(id: string): string {
  return `${BASE}/api/missions/${id}/stream`;
}
