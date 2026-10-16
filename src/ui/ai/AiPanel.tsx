// FlowState Assist: the floating AI panel (non-modal, so the auto gate preview on the sheet stays usable), the settings
// dialog, the ribbon tab content and the title bar entry. Nothing is sent without an explicit click.
import type { ReactNode } from 'react';
import { useAiSettings } from '../../ai/settings';
import { useStore } from '../../state/store';
import { Icon } from '../icons';
import { AiSettingsDialog } from './AiSettings';
import { CheckView, ExperimentView, MarkersView, WriterView } from './DocViews';
import { GateView, StrategyView } from './GateViews';
import { AI_TITLES, openAi, SparkIcon, useAiPanel, useProvider, type AiView } from './shared';
import './ai.css';

export function AiLayer() {
  const view = useAiPanel((s) => s.view);
  const dialog = useStore((s) => s.ui.dialog);
  return (
    <>
      {view && <AiPanel view={view} />}
      {dialog?.kind === 'aiSettings' && <AiSettingsDialog payload={dialog.payload as { reason?: AiView; itemId?: string | null } | undefined} onClose={() => useStore.getState().setUI({ dialog: null })} />}
    </>
  );
}

function AiPanel({ view }: { view: AiView }) {
  const provider = useProvider();
  const close = useAiPanel((s) => s.close);
  const body: Record<AiView, ReactNode> = {
    experiment: <ExperimentView provider={provider} />,
    gate: <GateView provider={provider} />,
    strategy: <StrategyView provider={provider} />,
    markers: <MarkersView provider={provider} />,
    writer: <WriterView provider={provider} />,
    check: <CheckView provider={provider} />,
  };
  // data-ag-keep: pressing in the panel does not commit a pending auto gate preview
  return (
    <section className="ai-panel" role="dialog" aria-label={AI_TITLES[view]} data-ag-keep="" onKeyDown={(e) => e.key === 'Escape' && e.target === e.currentTarget && close()} tabIndex={-1}>
      <div className="ai-head">
        <SparkIcon />
        <b>{AI_TITLES[view]}</b>
        <span className="ai-prov" title={provider?.label}>
          {provider ? `via ${provider.label}` : 'AI is off'}
        </span>
        <button className="btn xs" onClick={() => useStore.getState().setUI({ dialog: { kind: 'aiSettings' } })} title="AI assistant settings">
          Settings
        </button>
        <button className="icon-btn" aria-label="Close" title="Close" onClick={close}>
          ×
        </button>
      </div>
      <div className="ai-body" key={view}>
        {body[view]}
      </div>
    </section>
  );
}

function RBtn({ icon, label, title, onClick, on }: { icon: ReactNode; label: string; title: string; onClick: () => void; on?: boolean }) {
  return (
    <button className={`rbtn${on ? ' on' : ''}`} title={title} onClick={onClick} aria-pressed={on}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rgroup">
      <div className="rgroup-items">{children}</div>
      <div className="rgroup-label">{label}</div>
    </div>
  );
}

const ICONS: Record<AiView | 'settings', ReactNode> = {
  experiment: <Icon.eye />,
  gate: <SparkIcon />,
  strategy: <Icon.gate />,
  markers: <Icon.axis />,
  writer: <Icon.text />,
  check: <Icon.eye />,
  settings: <Icon.gear />,
};

const TIPS: Record<AiView, string> = {
  experiment: 'The AI reads the files (instrument, channels, tube names, plates, event counts and medians) and suggests groups, the setup and the next steps',
  gate: 'The AI finds a population (e.g. lymphocytes) on a plot; the auto gate draws it as a preview',
  strategy: 'The AI proposes a gating hierarchy for this panel; edit it, then build it step by step',
  markers: 'Suggest marker labels from the FCS keywords and a pasted panel',
  writer: 'Draft a MIFlowCyt-style methods paragraph or a figure legend',
  check: 'Review the plots and counts of this sheet for common gating problems',
};

/** Content of the ribbon's AI tab. */
export function AiRibbonGroups() {
  const provider = useProvider();
  const off = useAiSettings((s) => s.provider === 'off');
  const open = useAiPanel((s) => s.view);
  const sel = useStore((s) => s.ui.selectedItemIds);
  const tip = (v: AiView) => (provider ? TIPS[v] : `${TIPS[v]}. The AI assistant is ${off ? 'off' : 'not set up'}: click to open AI settings.`);
  const btn = (v: AiView, label: string) => <RBtn icon={ICONS[v]} label={label} title={tip(v)} on={open === v} onClick={() => void openAi(v, v === 'gate' ? sel[0] : null)} />;
  return (
    <>
      <Group label="Start">{btn('experiment', 'AI auto-analysis')}</Group>
      <Group label="Gate">
        {btn('gate', 'Gate with AI')}
        {btn('strategy', 'Gating strategy')}
      </Group>
      <Group label="Panel">{btn('markers', 'Marker labels')}</Group>
      <Group label="Write">{btn('writer', 'Methods & legend')}</Group>
      <Group label="Review">{btn('check', 'Check analysis')}</Group>
      <Group label="Assistant">
        <RBtn icon={ICONS.settings} label="AI settings" title="Provider, key, what is sent, privacy" onClick={() => useStore.getState().setUI({ dialog: { kind: 'aiSettings' } })} />
        <span className="ai-note" style={{ alignSelf: 'center', maxWidth: 170, fontSize: 11, lineHeight: 1.3 }}>
          {provider ? provider.label : off ? 'Off. Nothing is sent.' : 'Not set up yet.'}
        </span>
      </Group>
    </>
  );
}

/** Status bar privacy note (with the assistant on, plot images and counts leave the browser when you send them). */
export function AiPrivacyNote() {
  const off = useAiSettings((s) => s.provider === 'off');
  return (
    <span className="privacy" title={off ? undefined : 'Event data stay in this browser. AI actions send plot images, names and counts to Anthropic, only when you click Send.'}>
      {off ? 'Data stays in this browser' : 'Data stays in this browser · AI on'}
    </span>
  );
}

/** Title bar entry: shows whether the assistant is on; opens the AI tab (and the settings while it is off). */
export function AiTitleButton() {
  const off = useAiSettings((s) => s.provider === 'off');
  return (
    <button
      className={`tb-btn ai-tb${off ? '' : ' on'}`}
      title={off ? 'AI assistant: off. Click to set it up.' : 'AI assistant: on (only sends something when you start an AI action)'}
      aria-label="AI assistant"
      onClick={() => {
        const st = useStore.getState();
        st.setUI({ ribbonTab: 'ai', ...(off ? { dialog: { kind: 'aiSettings' } } : {}) });
      }}
    >
      <SparkIcon />
      AI
    </button>
  );
}
