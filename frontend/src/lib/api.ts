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
  return r.json();
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
