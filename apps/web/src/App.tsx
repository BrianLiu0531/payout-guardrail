import { useEffect, useState } from 'react';
import { AttackLab } from './attacks/AttackLab.js';
import { LedgerPage } from './ledger/LedgerPage.js';
import { PayeesPage } from './payouts/PayeesPage.js';
import { PayoutsPage } from './payouts/PayoutsPage.js';
import { SecurityPage } from './security/SecurityPage.js';
import { SessionBar } from './session.js';

const PAGES = [
  { path: '#/payouts', label: 'Payouts', render: () => <PayoutsPage /> },
  { path: '#/payees', label: 'Payees', render: () => <PayeesPage /> },
  { path: '#/security', label: 'Security', render: () => <SecurityPage /> },
  { path: '#/attacks', label: 'Attack lab', render: () => <AttackLab /> },
  { path: '#/ledger', label: 'Ledger', render: () => <LedgerPage /> },
] as const;

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const page = PAGES.find((p) => p.path === hash) ?? PAGES[0];
  useEffect(() => {
    document.title = `${page.label} · Payout Guardrail`;
  }, [page]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <img src="/favicon.svg" alt="" width={22} height={22} />
            <span>Payout Guardrail</span>
            <span className="env-badge" title="Local test chain (anvil). No real funds.">
              Testnet
            </span>
          </div>
          <SessionBar />
        </div>
        <nav aria-label="Main" className="nav">
          {PAGES.map((p) => (
            <a key={p.path} className="nav-link" href={p.path} aria-current={p === page ? 'page' : undefined}>
              {p.label}
            </a>
          ))}
        </nav>
      </header>
      <main id="main" className="container">
        {page.render()}
      </main>
    </>
  );
}
