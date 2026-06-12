import type { ReplayEvent, RoomState } from "../types";

interface SupabaseMatchPayload {
  status: "finished" | "aborted";
  winner_id: string | null;
  started_at?: string;
  ended_at: string;
}

export class ReplaySaver {
  constructor(private readonly env: Record<string, string | undefined>) {}

  async saveFinishedMatch(state: RoomState, events: ReplayEvent[]): Promise<void> {
    const url = this.env.SUPABASE_URL;
    const serviceKey = this.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
      return;
    }

    const matchId = state.matchId;
    const winningPlayer = state.players.find((player) => player.id === state.winnerId);
    const headers = {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates"
    };

    const matchPayload: SupabaseMatchPayload = {
      status: "finished",
      winner_id: winningPlayer?.userId ?? null,
      ended_at: new Date().toISOString()
    };

    await this.upsert(`${url}/rest/v1/matches`, headers, {
      id: matchId,
      ...matchPayload
    });

    const players = state.players
      .filter((player) => player.userId)
      .map((player) => ({
        match_id: matchId,
        user_id: player.userId,
        team_index: player.slot
      }));

    if (players.length > 0) {
      await this.upsert(`${url}/rest/v1/match_players`, headers, players);
    }

    await this.upsert(`${url}/rest/v1/replays`, headers, {
      match_id: matchId,
      event_log: events
    });
  }

  private async upsert(url: string, headers: Record<string, string>, body: unknown): Promise<void> {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Supabase write failed: ${response.status} ${await response.text()}`);
    }
  }
}
