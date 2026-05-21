import { MemorySessionStore, type SessionStore } from "./lib/sessions";

export async function createSessionStore(): Promise<SessionStore> {
  return new MemorySessionStore();
}
