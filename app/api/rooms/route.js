import { NextResponse } from "next/server";
import { generateRoomCode } from "@/lib/multiplayer/client";

export async function POST() {
  return NextResponse.json({
    roomCode: generateRoomCode()
  });
}
