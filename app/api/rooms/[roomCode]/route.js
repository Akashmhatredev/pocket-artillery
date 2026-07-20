import { NextResponse } from "next/server";
import { normalizeRoomCode } from "@/lib/multiplayer/client";

export async function GET(_request, context) {
  const { roomCode } = await context.params;
  const normalized = normalizeRoomCode(roomCode);

  if (normalized.length < 4) {
    return NextResponse.json({ error: "Invalid room code" }, { status: 400 });
  }

  return NextResponse.json({
    roomCode: normalized,
    valid: true
  });
}
