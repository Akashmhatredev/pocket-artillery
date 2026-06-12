import type { Connection, Party, PartyServer, Request as PartyRequest } from "partykit/server";
import { MatchHandler } from "./handlers/MatchHandler";

export default class GameRoom implements PartyServer {
  private readonly match: MatchHandler;

  constructor(readonly party: Party) {
    this.match = new MatchHandler(party);
  }

  onConnect(conn: Connection): void {
    this.match.handleJoin(conn);
  }

  onClose(conn: Connection): void {
    this.match.handleClose(conn);
  }

  async onMessage(message: string | ArrayBuffer, sender: Connection): Promise<void> {
    if (typeof message !== "string") {
      sender.send(JSON.stringify({
        type: "ERROR",
        code: "INVALID_MESSAGE",
        message: "Only JSON text messages are supported."
      }));
      return;
    }

    try {
      await this.match.processEvent(JSON.parse(message), sender);
    } catch {
      sender.send(JSON.stringify({
        type: "ERROR",
        code: "INVALID_JSON",
        message: "Message must be valid JSON."
      }));
    }
  }

  onRequest(request: PartyRequest): Response {
    if (request.method === "GET") {
      return Response.json({
        ok: true,
        roomId: this.party.id,
        service: "pocket-artillery"
      });
    }

    return new Response("Not found", { status: 404 });
  }
}
