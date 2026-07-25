"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bug, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Inbox debug panel.
 *
 * Enabled when `?debug=1` is in the URL OR
 * `localStorage.wacrm_debug === '1'`. When enabled a floating bug icon
 * appears in the bottom-right of the inbox; clicking it opens a drawer
 * with three tabs:
 *
 *  - Contact + Conversation raw rows (why name/phone/avatar isn't rendering)
 *  - Recent messages raw rows (why media URLs / content_type look wrong)
 *  - Raw WAHA webhook events matched to this chat (what actually arrived)
 *
 * The drawer is a client component and only reads — it never mutates —
 * so it's safe to leave enabled while agents work.
 */

type DebugData = {
  conversation: Record<string, unknown> | null;
  contact: Record<string, unknown> | null;
  messages: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  diagnostics: string[];
  matched_by: { phone_digits: string };
};

function useDebugEnabled(): [boolean, (v: boolean) => void] {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    try {
      const urlFlag = new URLSearchParams(window.location.search).get("debug");
      const stored = window.localStorage.getItem("wacrm_debug");
      const initial = urlFlag === "1" || stored === "1";
      setEnabled(initial);
      if (urlFlag === "1") window.localStorage.setItem("wacrm_debug", "1");
    } catch {
      // ignore
    }
  }, []);
  const update = useCallback((v: boolean) => {
    setEnabled(v);
    try {
      window.localStorage.setItem("wacrm_debug", v ? "1" : "0");
    } catch {
      // ignore
    }
  }, []);
  return [enabled, update];
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted/40 p-3 text-[11px] leading-relaxed">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function InboxDebugPanel({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const [enabled, setEnabled] = useDebugEnabled();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"overview" | "messages" | "events">("overview");
  const [data, setData] = useState<DebugData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!conversationId) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/whatsapp/debug/conversation/${conversationId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as DebugData;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const summary = useMemo(() => {
    if (!data) return null;
    const c = data.contact ?? {};
    const conv = data.conversation ?? {};
    return {
      name: c.name ?? null,
      phone: c.phone ?? null,
      avatar_url: c.avatar_url ?? null,
      contact_id: c.id ?? null,
      conversation_id: conv.id ?? null,
      status: conv.status ?? null,
      last_message_text: conv.last_message_text ?? null,
      last_message_at: conv.last_message_at ?? null,
      unread_count: conv.unread_count ?? null,
      messages_count: data.messages.length,
      events_count: data.events.length,
      matched_by_phone: data.matched_by.phone_digits || "(none)",
    };
  }, [data]);

  if (!enabled) return null;

  return (
    <>
      {/* Floating toggle. Fixed bottom-right so it doesn't fight the
          contact sidebar or the composer's send button. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed bottom-4 right-4 z-40 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-background/90 text-foreground shadow-lg backdrop-blur transition hover:bg-muted",
          open && "bg-primary text-primary-foreground hover:bg-primary/90",
        )}
        title="Toggle debug panel"
      >
        <Bug className="h-4 w-4" />
      </button>

      {open && (
        <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border bg-background shadow-xl sm:w-[440px]">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <Bug className="h-4 w-4 text-primary" />
              <div>
                <p className="text-sm font-semibold">Depuração da inbox</p>
                <p className="text-[11px] text-muted-foreground">
                  Payload bruto do webhook + linhas do banco
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void load()}
                disabled={!conversationId || loading}
                className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                title="Recarregar"
              >
                <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                title="Fechar"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1 border-b border-border px-4 pt-2">
            {(
              [
                ["overview", "Visão geral"],
                ["messages", `Mensagens${data ? ` (${data.messages.length})` : ""}`],
                ["events", `Webhook${data ? ` (${data.events.length})` : ""}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn(
                  "rounded-t-md px-3 py-1.5 text-xs font-medium transition",
                  tab === key
                    ? "border-b-2 border-primary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-4">
            {!conversationId && (
              <p className="text-xs text-muted-foreground">
                Selecione uma conversa para inspecionar seus dados brutos.
              </p>
            )}
            {conversationId && loading && !data && (
              <p className="text-xs text-muted-foreground">Carregando…</p>
            )}
            {error && (
              <p className="text-xs text-destructive">Erro: {error}</p>
            )}

            {conversationId && data && tab === "overview" && (
              <div className="space-y-4">
                {data.diagnostics.length > 0 && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-amber-500">
                      Diagnóstico
                    </p>
                    <ul className="space-y-1 text-[11px] text-amber-900 dark:text-amber-200">
                      {data.diagnostics.map((d, i) => (
                        <li key={i}>• {d}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Resumo
                  </p>
                  <Json value={summary} />
                </div>
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Contact (raw)
                  </p>
                  <Json value={data.contact} />
                </div>
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Conversation (raw)
                  </p>
                  <Json value={data.conversation} />
                </div>
              </div>
            )}

            {conversationId && data && tab === "messages" && (
              <div className="space-y-3">
                {data.messages.length === 0 && (
                  <p className="text-xs text-muted-foreground">Sem mensagens.</p>
                )}
                {data.messages.map((m) => (
                  <div key={String(m.id)} className="rounded-md border border-border p-2">
                    <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                      <span>{String(m.content_type)} · {String(m.sender_type)}</span>
                      <span>{String(m.created_at)}</span>
                    </div>
                    <Json value={m} />
                  </div>
                ))}
              </div>
            )}

            {conversationId && data && tab === "events" && (
              <div className="space-y-3">
                {data.events.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Nenhum evento bruto de webhook capturado para este chat.
                    Envie uma mensagem de teste e recarregue.
                  </p>
                )}
                {data.events.map((e) => (
                  <div key={String(e.id)} className="rounded-md border border-border p-2">
                    <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                      <span>
                        {String(e.event ?? "?")} → {String(e.outcome ?? "?")}
                      </span>
                      <span>{String(e.created_at)}</span>
                    </div>
                    <Json value={e} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
            Debug ativo · <button
              type="button"
              onClick={() => {
                setEnabled(false);
                setOpen(false);
              }}
              className="underline hover:text-foreground"
            >
              desativar
            </button>
          </div>
        </div>
      )}
    </>
  );
}
