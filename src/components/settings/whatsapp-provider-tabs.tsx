'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { WhatsAppConfig } from './whatsapp-config';
import { WahaConfigPanel } from './waha-config';
import { SettingsPanelHead } from './settings-panel-head';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

type Provider = 'meta' | 'waha';

/**
 * Container that lets the user pick which WhatsApp transport backs
 * their account. Both providers write to the same `whatsapp_config`
 * row (one per account), keyed by the `provider` column — only one
 * can be active at a time. On mount we probe both endpoints, auto-
 * select the tab matching the active provider, and mark it with a
 * green check so the user always knows which one is live.
 */
export function WhatsAppProviderTabs() {
  const [tab, setTab] = useState<Provider>('meta');
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null);
  const [probed, setProbed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [metaRes, wahaRes] = await Promise.all([
          fetch('/api/whatsapp/config', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
          fetch('/api/whatsapp/waha', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        ]);
        if (cancelled) return;
        // WAHA row present (has base_url) → WAHA is active. Otherwise if
        // Meta responded with anything other than "other_provider_active"
        // AND has a saved config (connected or reason !== 'no_config'),
        // Meta is active.
        let active: Provider | null = null;
        if (wahaRes?.base_url) active = 'waha';
        else if (metaRes && metaRes.reason !== 'no_config' && metaRes.reason !== 'other_provider_active' && metaRes.reason !== 'no_account') {
          active = 'meta';
        } else if (metaRes?.connected) {
          active = 'meta';
        }
        setActiveProvider(active);
        if (active) setTab(active);
      } finally {
        if (!cancelled) setProbed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const showSwitchWarning =
    probed && activeProvider !== null && activeProvider !== tab;

  return (
    <div className="space-y-4">
      <SettingsPanelHead
        title="WhatsApp"
        description="Escolha como conectar o WhatsApp da sua conta. Apenas um provedor pode ficar ativo por vez."
      />
      <div
        role="tablist"
        aria-label="Provedor WhatsApp"
        className="inline-flex rounded-lg border bg-muted/40 p-1"
      >
        <TabButton active={tab === 'meta'} onClick={() => setTab('meta')} live={activeProvider === 'meta'}>
          API oficial (Meta)
        </TabButton>
        <TabButton active={tab === 'waha'} onClick={() => setTab('waha')} live={activeProvider === 'waha'}>
          API não-oficial (WAHA)
        </TabButton>
      </div>

      {showSwitchWarning && (
        <Alert>
          <AlertTitle>
            {activeProvider === 'waha'
              ? 'WAHA está ativo nesta conta'
              : 'API oficial (Meta) está ativa nesta conta'}
          </AlertTitle>
          <AlertDescription>
            {activeProvider === 'waha'
              ? 'Para usar a API oficial da Meta, primeiro desconecte o WAHA na aba correspondente. Salvar aqui trocará o provedor ativo e apagará a configuração atual.'
              : 'Para usar o WAHA, primeiro desconecte a API oficial na aba Meta. Salvar aqui trocará o provedor ativo e apagará a configuração atual.'}
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-4">
        {tab === 'meta' ? <WhatsAppConfig /> : <WahaConfigPanel />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  live,
  children,
}: {
  active: boolean;
  onClick: () => void;
  live?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
      {live && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-label="Ativo" />}
    </button>
  );
}
