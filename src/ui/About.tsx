// "About FlowState": version, license (AGPL-3.0), contact, intended use, privacy, trademark notice and the third-party
// licenses (LICENSE and THIRD_PARTY_NOTICES.md are bundled as text so the single-file build carries its own notices).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import licenseText from '../../LICENSE?raw';
import notices from '../../THIRD_PARTY_NOTICES.md?raw';
import { saveFile } from '../io/files';
import { APP_AFFILIATION, APP_AUTHOR, APP_CONTACT_EMAIL, APP_COPYRIGHT, APP_LICENSE, APP_STAGE, APP_URL, APP_VERSION, NAMED_COMPANIES, contactMailto } from '../legal/meta';
import { LogoMark } from './Logo';
import { Modal } from './widgets';

/** Third-party components in the app (details and full texts: THIRD_PARTY_NOTICES.md). */
const COMPONENTS: [string, string][] = [
  ['React, React DOM, scheduler, use-sync-external-store', 'MIT'],
  ['zustand, immer, fflate, Vite module preload helper', 'MIT'],
  ['FlowState Sans / Serif / Humanist fonts: renamed subsets of Liberation Sans, Liberation Serif and Carlito', 'SIL OFL 1.1'],
  ['Viridis, magma, inferno, plasma colormaps (matplotlib)', 'CC0 1.0'],
  ['Cividis, jet, heat, rainbow colormap data (matplotlib; cividis: Battelle)', 'Matplotlib / BSD-style'],
  ['Turbo colormap (Google LLC); ColorBrewer color schemes (C. Brewer, Penn State)', 'Apache 2.0'],
  ['Haline and ice colormaps (cmocean, K. M. Thyng)', 'MIT'],
  ['Logicle reference implementation (Stanford University)', 'BSD-style'],
  ['FlowJo biex table and ellipse geometry, ported from FlowKit (S. White)', 'BSD 3-Clause'],
];

/** FlowState's own license and the third-party notices, as one text (shown and saved from About). */
const LEGAL_TEXT = [
  `FlowState ${APP_VERSION}`,
  APP_COPYRIGHT ?? '',
  '',
  `FlowState is licensed under the GNU Affero General Public License, version 3 only (${APP_LICENSE}).`,
  'Third-party components keep their own licenses (second part).',
  '',
  '==================== FlowState license ====================',
  '',
  licenseText.trim(),
  '',
  '==================== Third-party notices ====================',
  '',
  notices,
].join('\n');

const PRODUCT_NAMES = 'CytExpert, CytoFLEX, Kaluza, Gallios, Navios, nanoViS, FlowJo, BD FACSDiva, SpectroFlo, Attune, FlowLogic, FCS Express';

/**
 * Other servers this page has contacted (resource timing, incl. fetch calls, and external links / scripts in the document).
 * The app itself loads nothing from other servers; optional online features and anything a host adds (web fonts,
 * analytics) show up here, and the privacy note names them.
 */
function remoteHosts(): string[] {
  if (typeof document === 'undefined' || typeof location === 'undefined') return [];
  const hosts = new Set<string>();
  const add = (u: string) => {
    try {
      const url = new URL(u, location.href);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== location.origin) hosts.add(url.host);
    } catch {
      /* not a URL */
    }
  };
  try {
    for (const e of performance.getEntriesByType('resource')) add(e.name);
  } catch {
    /* no resource timing */
  }
  document.querySelectorAll<HTMLLinkElement>('link[href]').forEach((el) => add(el.href));
  document.querySelectorAll<HTMLScriptElement>('script[src]').forEach((el) => add(el.src));
  return [...hosts].sort();
}

/** "i" icon for the title bar button. */
export function AboutIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6" />
      <circle cx="12" cy="7.6" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

const H = ({ children }: { children: string }) => <h3 style={{ margin: '14px 0 4px', fontSize: 13, fontWeight: 600 }}>{children}</h3>;
const P = ({ children }: { children: ReactNode }) => <p style={{ margin: '0 0 6px', lineHeight: 1.45 }}>{children}</p>;

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [showTexts, setShowTexts] = useState(false);
  const textsRef = useRef<HTMLPreElement>(null);
  const remote = remoteHosts();
  useEffect(() => {
    if (showTexts) textsRef.current?.scrollIntoView({ block: 'nearest' });
  }, [showTexts]);
  return (
    <Modal
      title="About FlowState"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={() => void saveFile('FlowState-licenses.txt', LEGAL_TEXT)} title="Save FlowState's license and the third-party notices as a text file">
            Save licenses as text
          </button>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div style={{ fontSize: 12.5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <LogoMark size={40} />
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>FlowState</div>
            <div style={{ color: 'var(--text-2)' }}>
              Version {APP_VERSION} <span className="beta-tag">{APP_STAGE}</span>
            </div>
          </div>
        </div>
        <P>
          Flow cytometry analysis in the web browser: FCS import, gating, compensation and spectral unmixing, bead calibration, statistics and
          publication figures. Reads and writes the open ISAC standards FCS 3.1 and Gating-ML 2.0.
        </P>
        <P>
          {APP_COPYRIGHT}.
          <br />
          FlowState is free software: you may use, share and change it under the terms of the GNU Affero General Public License, version 3
          ({APP_LICENSE}). Changed versions that are shared, or offered to others as a web service, must stay under this license and come with
          their source code. FlowState comes with absolutely no warranty. Source code:{' '}
          {APP_URL ? (
            <a href={APP_URL} target="_blank" rel="noopener noreferrer" className="contact-mail">
              {APP_URL}
            </a>
          ) : (
            <>
              on request from{' '}
              <a href={contactMailto('Source code')} target="_blank" rel="noopener noreferrer" className="contact-mail">
                {APP_CONTACT_EMAIL}
              </a>
            </>
          )}
          .
        </P>

        <H>Contact</H>
        <P>
          {APP_AUTHOR}
          {APP_AFFILIATION.map((l) => (
            <span key={l}>
              <br />
              {l}
            </span>
          ))}
          <br />
          Questions, bug reports and ideas:{' '}
          <a href={contactMailto()} target="_blank" rel="noopener noreferrer" className="contact-mail">
            {APP_CONTACT_EMAIL}
          </a>
          <br />
          <span style={{ color: 'var(--text-2)' }}>
            For a bug, the version above and a short description of the steps help; please do not attach unpublished data or patient data.
          </span>
        </P>

        <H>Intended use</H>
        <P>
          <b>For research use only. Not for use in diagnostic procedures or for clinical decisions.</b> FlowState is provided free of charge and
          &quot;as is&quot;, without warranty of any kind.
        </P>
        <P>
          <b>Beta software, work in progress.</b> Unexpected behaviour can occur, and features and file formats may still change. Please
          verify critical results against the raw data or another program. Found a problem or have an idea? Let me know:{' '}
          <a href={contactMailto('Problem report')} target="_blank" rel="noopener noreferrer" className="contact-mail">
            {APP_CONTACT_EMAIL}
          </a>
          .
        </P>

        <H>Privacy</H>
        <P>
          Your data are processed locally in your browser. FCS files, workspaces and figures are not uploaded to any server (event data never leave the browser); the autosave copy is
          kept in this browser&apos;s storage (IndexedDB) until you clear it.{' '}
          The app loads no web fonts, scripts or analytics from other servers; it contacts a server only for an optional online feature
          that you set up yourself, and then only that feature&apos;s service. The optional AI assistant is off by default; when you start an AI action,
          the plot images, channel, marker and gate names, counts and the text shown before sending go to Anthropic (via your claude.ai account,
          your API key or your lab&apos;s proxy).{' '}
          {remote.length
            ? `In this session the page has contacted ${remote.join(', ')}, which ${remote.length > 1 ? 'receive' : 'receives'} your IP address.`
            : 'In this session it has not contacted any server.'}
        </P>

        <H>Trademarks</H>
        <P>
          FlowState is an independent project. It is not affiliated with, endorsed by or sponsored by {NAMED_COMPANIES.slice(0, -1).join(', ')} or{' '}
          {NAMED_COMPANIES[NAMED_COMPANIES.length - 1]}, or any other instrument, reagent or software vendor. {PRODUCT_NAMES} and all other product
          names, trademarks and registered trademarks are the property of their respective owners and are used here only to identify compatible
          file formats, instruments and reagents.
        </P>

        <H>Methods</H>
        <P>
          Logicle display (Parks, Roederer &amp; Moore 2006; Moore &amp; Parks 2012), Mie scattering of spheres and coated spheres (Bohren &amp;
          Huffman 1983), light-scatter calibration after FCMPASS (Welsh et al. 2020).
        </P>

        <H>Third-party software and data</H>
        <table className="about-licenses" style={{ width: '100%', borderCollapse: 'collapse', margin: '2px 0 8px' }}>
          <tbody>
            {COMPONENTS.map(([what, lic]) => (
              <tr key={what} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ padding: '3px 8px 3px 0' }}>{what}</td>
                <td style={{ padding: '3px 0', whiteSpace: 'nowrap', color: 'var(--text-2)' }}>{lic}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn sm" aria-expanded={showTexts} onClick={() => setShowTexts((v) => !v)}>
          {showTexts ? 'Hide' : 'Show'} license and third-party notices
        </button>
        {showTexts && (
          <pre
            ref={textsRef}
            tabIndex={0}
            aria-label="FlowState license and third-party notices"
            style={{
              marginTop: 8,
              maxHeight: '40vh',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              lineHeight: 1.4,
              padding: 10,
              background: 'var(--panel-sunk)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
            }}
          >
            {LEGAL_TEXT}
          </pre>
        )}
      </div>
    </Modal>
  );
}
