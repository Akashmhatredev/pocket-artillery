import { MatchHandler } from "./handlers/MatchHandler";

export default class GameRoom {
  constructor(party) {
    this.party = party;
    this.match = new MatchHandler(party);
  }

  onConnect(conn) {
    this.match.handleJoin(conn);
  }

  onClose(conn) {
    this.match.handleClose(conn);
  }

  async onMessage(message, sender) {
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

  onRequest(request) {
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
