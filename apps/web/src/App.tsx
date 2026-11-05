import { LedgerPage } from './ledger/LedgerPage.js';

export function App() {
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
            <span className="env-badge" title="Runs against Base Sepolia only">
              Testnet
            </span>
          </div>
          <nav aria-label="Main">
            <a className="nav-link" aria-current="page" href="/">
              Ledger
            </a>
          </nav>
        </div>
      </header>
      <main id="main" className="container">
        <LedgerPage />
      </main>
    </>
  );
}
