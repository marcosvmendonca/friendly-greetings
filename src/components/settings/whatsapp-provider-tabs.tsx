'use client';

import { useState } from 'react';
import { WhatsAppConfig } from './whatsapp-config';
import { WahaConfigPanel } from './waha-config';
import { SettingsPanelHead } from './settings-panel-head';
import { cn } from '@/lib/utils';

/**
 * Container that lets the user pick which WhatsApp transport backs
 * their account. Both providers write to the same `whatsapp_config`
 * row (one per account), keyed by the `provider` column — switching
 * tabs is purely a UI affordance; the persisted provider is whatever
 * the user last saved in the corresponding panel.
 */
export function WhatsAppProviderTabs() {
  const [tab, setTab] = useState<'meta' | 'waha'>('meta');
  return (
    <div className="space-y-4">
      <SettingsPanelHead
        title="WhatsApp"
        description="Escolha como conectar o WhatsApp da sua conta."
      />
      <div
        role="tablist"
        aria-label="Provedor WhatsApp"
        className="inline-flex rounded-lg border bg-muted/40 p-1"
      >
        <TabButton active={tab === 'meta'} onClick={() => setTab('meta')}>
          API oficial (Meta)
        </TabButton>
        <TabButton active={tab === 'waha'} onClick={() => setTab('waha')}>
          API não-oficial (WAHA)
        </TabButton>
      </div>
      <div className="mt-4">
        {tab === 'meta' ? <WhatsAppConfig /> : <WahaConfigPanel />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
