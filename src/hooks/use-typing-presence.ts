"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";

/**
 * Live "está digitando…" / "gravando áudio…" indicator between agents
 * viewing the same conversation.
 *
 * Uses a Supabase Realtime broadcast channel per conversation — pure
 * ephemeral pub/sub, nothing hits the database. Each active client
 * emits `activity` events describing what they're doing; peers hold
 * the last event per user and auto-expire it after ~4s so a closed
 * tab or a stuck client can't leave a ghost indicator on-screen.
 *
 * Scoped to internal team members (the same wacrm account). The
 * end-customer on WhatsApp is unaffected — this is just so multiple
 * agents in the inbox see each other's activity in real time.
 */

export type TypingActivity = "typing" | "recording";

interface ActivityEntry {
  userId: string;
  name: string;
  kind: TypingActivity;
  /** Local receive time; used for the client-side TTL. */
  receivedAt: number;
}

interface UseTypingPresenceResult {
  /** Peers currently typing/recording in this conversation (excludes self). */
  peers: ActivityEntry[];
  /**
   * Report the current user's activity. Pass `null` to clear.
   * Safe to call every keystroke — sends are throttled internally.
   */
  report: (kind: TypingActivity | null) => void;
}

/** How long an activity event lives before the viewer forgets it. */
const ACTIVITY_TTL_MS = 4_000;
/** How often the viewer re-evaluates TTLs to drop stale peers. */
const TICK_MS = 1_500;
/** Minimum gap between outgoing broadcasts of the SAME kind. */
const SEND_THROTTLE_MS = 2_000;

export function useTypingPresence(
  conversationId: string | null | undefined,
): UseTypingPresenceResult {
  const { user, profile } = useAuth();
  const userId = user?.id ?? null;
  const selfName =
    profile?.full_name?.trim() || user?.email?.split("@")[0] || "Alguém";

  const [peers, setPeers] = useState<ActivityEntry[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  // Track the last time we sent EACH kind so switching typing→recording
  // isn't blocked by the throttle of the other kind.
  const lastSentRef = useRef<Record<string, number>>({});
  const lastKindRef = useRef<TypingActivity | null>(null);

  useEffect(() => {
    if (!conversationId || !userId) return;

    const supabase = createClient();
    const channel = supabase.channel(`typing:${conversationId}`, {
      config: { broadcast: { self: false } },
    });
    channelRef.current = channel;

    channel
      .on("broadcast", { event: "activity" }, ({ payload }) => {
        const p = payload as {
          userId?: string;
          name?: string;
          kind?: TypingActivity | "idle";
        };
        if (!p?.userId || p.userId === userId) return;
        setPeers((prev) => {
          const others = prev.filter((e) => e.userId !== p.userId);
          if (p.kind === "typing" || p.kind === "recording") {
            others.push({
              userId: p.userId,
              name: p.name || "Alguém",
              kind: p.kind,
              receivedAt: Date.now(),
            });
          }
          return others;
        });
      })
      .subscribe();

    // TTL sweep — drops peers whose last event is older than the TTL.
    const tick = setInterval(() => {
      const cutoff = Date.now() - ACTIVITY_TTL_MS;
      setPeers((prev) => {
        const kept = prev.filter((e) => e.receivedAt >= cutoff);
        return kept.length === prev.length ? prev : kept;
      });
    }, TICK_MS);

    return () => {
      clearInterval(tick);
      // Best-effort "I'm gone" so peers drop us instantly instead of
      // waiting for the TTL.
      channel
        .send({
          type: "broadcast",
          event: "activity",
          payload: { userId, name: selfName, kind: "idle" },
        })
        .catch(() => {});
      supabase.removeChannel(channel);
      channelRef.current = null;
      lastKindRef.current = null;
      lastSentRef.current = {};
      setPeers([]);
    };
  }, [conversationId, userId, selfName]);

  const report = useCallback(
    (kind: TypingActivity | null) => {
      const channel = channelRef.current;
      if (!channel || !userId) return;

      // Sending idle: only broadcast if we were previously non-idle,
      // and always (no throttle) so peers clear quickly.
      if (kind === null) {
        if (lastKindRef.current === null) return;
        lastKindRef.current = null;
        channel
          .send({
            type: "broadcast",
            event: "activity",
            payload: { userId, name: selfName, kind: "idle" },
          })
          .catch(() => {});
        return;
      }

      const now = Date.now();
      const last = lastSentRef.current[kind] ?? 0;
      // If we're keeping the same kind alive, throttle. If we're
      // switching kind, send immediately so the indicator flips.
      if (lastKindRef.current === kind && now - last < SEND_THROTTLE_MS) return;

      lastKindRef.current = kind;
      lastSentRef.current[kind] = now;
      channel
        .send({
          type: "broadcast",
          event: "activity",
          payload: { userId, name: selfName, kind },
        })
        .catch(() => {});
    },
    [userId, selfName],
  );

  return { peers, report };
}
