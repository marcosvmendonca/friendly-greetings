"use client";

import { useEffect } from "react";
import { X, Download } from "lucide-react";
import { toast } from "sonner";

interface MediaLightboxProps {
  open: boolean;
  onClose: () => void;
  src: string;
  originalUrl?: string;
  filename?: string;
  kind?: "image" | "video";
}

/**
 * Visualizador simples de mídia em tela cheia. Recebe um `src` que já
 * pode ser um blob URL (para mídias autenticadas em /api/whatsapp/*)
 * ou uma URL pública. O download tenta baixar via fetch para preservar
 * o nome do arquivo mesmo quando o navegador ignora `download` em URLs
 * cross-origin.
 */
export function MediaLightbox({
  open,
  onClose,
  src,
  originalUrl,
  filename,
  kind = "image",
}: MediaLightboxProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleDownload = async () => {
    try {
      const url = originalUrl ?? src;
      const res = await fetch(url);
      if (!res.ok) throw new Error("fetch failed");
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename || `download-${Date.now()}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch {
      toast.error("Falha ao baixar arquivo");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute right-4 top-4 z-10 flex gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleDownload();
          }}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
          aria-label="Baixar"
          title="Baixar"
        >
          <Download className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
          aria-label="Fechar"
          title="Fechar (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div
        className="max-h-full max-w-full"
        onClick={(e) => e.stopPropagation()}
      >
        {kind === "video" ? (
          <video
            src={src}
            controls
            autoPlay
            className="max-h-[90vh] max-w-[95vw] rounded-lg"
          />
        ) : (
          <img
            src={src}
            alt={filename || "media"}
            className="max-h-[90vh] max-w-[95vw] rounded-lg object-contain"
          />
        )}
      </div>
    </div>
  );
}
