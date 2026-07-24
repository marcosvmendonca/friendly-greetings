'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Loader2, QrCode, CheckCircle2, XCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * WAHA (unofficial) provider panel. Sibling of the Meta config panel.
 * Flow:
 *   1. User submits WAHA base URL + API key + session name.
 *   2. Backend calls WAHA to start the session and stores encrypted
 *      credentials.
 *   3. Panel polls `GET /api/whatsapp/waha` every 3s to reflect
 *      status (SCAN_QR_CODE → WORKING) and renders the QR to scan.
 *   4. "Desconectar" logs out on WAHA and clears the row.
 */
export function WahaConfigPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>('STOPPED');
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState<{ id: string; pushName?: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [session, setSession] = useState('default');
  const [hasConfig, setHasConfig] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/waha', { cache: 'no-store' });
      const data = await res.json();
      setConnected(Boolean(data.connected));
      setStatus(data.status ?? 'STOPPED');
      setQr(data.qr ?? null);
      setMe(data.me ?? null);
      if (data.base_url) {
        setBaseUrl(data.base_url);
        setSession(data.session ?? 'default');
        setHasConfig(true);
      } else {
        setHasConfig(false);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll while a session exists and isn't fully connected — that's
  // when the status matters (SCAN_QR_CODE / STARTING / FAILED).
  useEffect(() => {
    if (!hasConfig) return;
    if (connected) return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [hasConfig, connected, refresh]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/waha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: baseUrl.trim(),
          api_key: apiKey.trim(),
          session: session.trim() || 'default',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Falha ao conectar ao WAHA');
        return;
      }
      toast.success('Sessão WAHA iniciada. Escaneie o QR code.');
      setApiKey('');
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm('Desconectar e apagar a configuração WAHA?')) return;
    const res = await fetch('/api/whatsapp/waha', { method: 'DELETE' });
    if (res.ok) {
      toast.success('WAHA desconectado.');
      setHasConfig(false);
      setConnected(false);
      setStatus('STOPPED');
      setQr(null);
      setMe(null);
    } else {
      toast.error('Falha ao desconectar.');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Alert>
        <AlertTitle>API não-oficial (WAHA)</AlertTitle>
        <AlertDescription>
          Envio e recepção de <strong>texto e mídia</strong>. Templates
          aprovados e botões interativos oficiais só funcionam pela API
          oficial (Meta). Requer uma instância WAHA rodando (ex: EasyPanel).
        </AlertDescription>
      </Alert>

      {hasConfig && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {connected ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  Conectado
                </>
              ) : (
                <>
                  <XCircle className="h-5 w-5 text-amber-500" />
                  {status}
                </>
              )}
            </CardTitle>
            <CardDescription>
              {connected && me?.id
                ? `WhatsApp: ${me.pushName ?? me.id}`
                : status === 'SCAN_QR_CODE'
                  ? 'Escaneie o QR code abaixo no aplicativo WhatsApp.'
                  : status === 'STARTING'
                    ? 'Iniciando a sessão…'
                    : 'Aguardando WAHA.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {qr && !connected && (
              <div className="flex flex-col items-center gap-2 rounded-md border p-4">
                <QrCode className="h-4 w-4 text-muted-foreground" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qr}
                  alt="QR code WAHA"
                  className="h-64 w-64 rounded bg-white p-2"
                />
                <p className="text-xs text-muted-foreground">
                  WhatsApp → Configurações → Aparelhos conectados → Conectar
                </p>
              </div>
            )}
            <div className="grid gap-1 text-xs text-muted-foreground">
              <div>
                <strong>URL:</strong> {baseUrl}
              </div>
              <div>
                <strong>Sessão:</strong> {session}
              </div>
            </div>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleDisconnect}
            >
              <Trash2 className="mr-2 h-4 w-4" /> Desconectar
            </Button>
          </CardContent>
        </Card>
      )}

      {!hasConfig && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Conectar via WAHA</CardTitle>
            <CardDescription>
              Preencha os dados da sua instância WAHA. Um QR code será
              exibido para você escanear com o WhatsApp.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSave} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="waha-base">URL da instância WAHA</Label>
                <Input
                  id="waha-base"
                  placeholder="https://waha.seudominio.com"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="waha-key">API Key (WHATSAPP_API_KEY)</Label>
                <Input
                  id="waha-key"
                  type="password"
                  placeholder="Sua chave da instância WAHA"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="waha-session">Nome da sessão</Label>
                <Input
                  id="waha-session"
                  placeholder="default"
                  value={session}
                  onChange={(e) => setSession(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Use “default” se você não criou uma sessão específica no
                  painel do WAHA.
                </p>
              </div>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Conectar
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
