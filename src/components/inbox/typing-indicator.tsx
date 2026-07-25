"use client";

import { Mic } from "lucide-react";
import { useTypingPresence } from "@/hooks/use-typing-presence";

/**
 * Renders "Fulano está digitando…" / "Fulano está gravando áudio…"
 * for teammates active on the SAME conversation. Reads from the same
 * broadcast channel the composer writes to — no DB round-trip.
 *
 * Shown as a compact strip right above the composer so it never
 * competes with the message thread itself.
 */
export function TypingIndicator({
  conversationId,
}: {
  conversationId: string | null | undefined;
}) {
  const { peers } = useTypingPresence(conversationId);
  if (peers.length === 0) return null;

  // If any peer is recording, that wins the primary label — recording
  // is the more specific / more attention-worthy state. Otherwise
  // fall back to typing.
  const recording = peers.filter((p) => p.kind === "recording");
  const typing = peers.filter((p) => p.kind === "typing");
  const primary = recording.length > 0 ? recording : typing;
  const kind = recording.length > 0 ? "recording" : "typing";

  const names = primary.map((p) => p.name);
  const label = formatLabel(names, kind);

  return (
    <div className="flex items-center gap-2 border-t bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
      {kind === "recording" ? (
        <Mic className="h-3.5 w-3.5 animate-pulse text-emerald-500" />
      ) : (
        <TypingDots />
      )}
      <span>{label}</span>
    </div>
  );
}

function formatLabel(names: string[], kind: "typing" | "recording"): string {
  const verb = kind === "recording" ? "gravando áudio" : "digitando";
  if (names.length === 1) return `${names[0]} está ${verb}…`;
  if (names.length === 2) return `${names[0]} e ${names[1]} estão ${verb}…`;
  return `${names[0]} e outros ${names.length - 1} estão ${verb}…`;
}

function TypingDots() {
  return (
    <span className="inline-flex items-end gap-0.5" aria-hidden>
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground" />
    </span>
  );
}
