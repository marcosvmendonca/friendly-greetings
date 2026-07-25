"use client";

import { useState } from "react";
import { Trash2, CheckCircle2, Circle, Clock, UserCheck, UserX, X, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface BulkActionsBarProps {
  selectedIds: string[];
  onClear: () => void;
  onDone: () => void;
}

/**
 * Barra flutuante com ações em massa para as conversas selecionadas.
 * Ativada via long-press (touch) ou clique direito (desktop) na lista.
 * Todas as ações batem em `POST /api/whatsapp/conversations/bulk`.
 */
export function BulkActionsBar({ selectedIds, onClear, onDone }: BulkActionsBarProps) {
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (payload: Record<string, unknown>, label: string) => {
    if (busy) return;
    setBusy(label);
    try {
      const res = await fetch("/api/whatsapp/conversations/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds, ...payload }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      toast.success(`${body.affected ?? selectedIds.length} conversa(s) atualizada(s)`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha na ação em massa");
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (
      !window.confirm(
        `Excluir ${selectedIds.length} conversa(s) e todas as mensagens? Essa ação não pode ser desfeita.`,
      )
    )
      return;
    await run({ action: "delete" }, "delete");
  };

  const handleStatus = (status: "open" | "pending" | "closed") =>
    run({ action: "status", status }, `status-${status}`);

  const handleAssignSelf = async () => {
    // Pega o próprio user id via endpoint account/members (já valida a conta).
    // Simplificação: consulta /api/account que retorna user_id do caller.
    try {
      const res = await fetch("/api/account", { method: "GET" });
      const data = await res.json().catch(() => ({}));
      const uid = data?.user?.id || data?.user_id;
      if (!uid) throw new Error("Não foi possível identificar seu usuário");
      await run({ action: "assign", assigned_agent_id: uid }, "assign-me");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao atribuir");
    }
  };

  const handleUnassign = () => run({ action: "assign", assigned_agent_id: null }, "unassign");

  return (
    <div className="flex items-center gap-1 border-b border-border bg-primary/5 px-2 py-1.5">
      <button
        onClick={onClear}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Cancelar seleção"
      >
        <X className="h-4 w-4" />
      </button>
      <span className="text-xs font-medium text-foreground">
        {selectedIds.length} selecionada(s)
      </span>
      <div className="ml-auto flex items-center gap-0.5">
        <ActionBtn onClick={() => handleStatus("open")} disabled={!!busy} title="Marcar aberta">
          <Circle className="h-3.5 w-3.5" />
        </ActionBtn>
        <ActionBtn
          onClick={() => handleStatus("pending")}
          disabled={!!busy}
          title="Marcar pendente"
        >
          <Clock className="h-3.5 w-3.5" />
        </ActionBtn>
        <ActionBtn
          onClick={() => handleStatus("closed")}
          disabled={!!busy}
          title="Marcar fechada"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
        </ActionBtn>
        <div className="mx-1 h-4 w-px bg-border" />
        <ActionBtn onClick={handleAssignSelf} disabled={!!busy} title="Atribuir a mim">
          <UserCheck className="h-3.5 w-3.5" />
        </ActionBtn>
        <ActionBtn onClick={handleUnassign} disabled={!!busy} title="Desatribuir">
          <UserX className="h-3.5 w-3.5" />
        </ActionBtn>
        <div className="mx-1 h-4 w-px bg-border" />
        <ActionBtn
          onClick={handleDelete}
          disabled={!!busy}
          title="Excluir"
          variant="danger"
        >
          {busy === "delete" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </ActionBtn>
      </div>
    </div>
  );
}

function ActionBtn({
  children,
  onClick,
  disabled,
  title,
  variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title: string;
  variant?: "danger";
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-50 " +
        (variant === "danger"
          ? "text-destructive hover:bg-destructive/10"
          : "text-muted-foreground hover:bg-muted hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}
