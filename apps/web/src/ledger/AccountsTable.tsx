import type { AccountDto } from '../api.js';
import { Amount } from './Amount.js';

const GROUPS: { type: AccountDto['type']; label: string }[] = [
  { type: 'asset', label: 'Assets' },
  { type: 'liability', label: 'Liabilities' },
  { type: 'equity', label: 'Equity' },
  { type: 'revenue', label: 'Revenue' },
  { type: 'expense', label: 'Expenses' },
];

interface Props {
  accounts: AccountDto[];
  selected: string | null;
  onSelect: (code: string | null) => void;
}

export function AccountsTable({ accounts, selected, onSelect }: Props) {
  return (
    <div className="table-scroll">
      <table className="table">
        <caption className="visually-hidden">Accounts with their balances. Select an account to filter the journal.</caption>
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col" className="num">
              Balance
            </th>
            <th scope="col" className="num wide-only">
              Debits
            </th>
            <th scope="col" className="num wide-only">
              Credits
            </th>
          </tr>
        </thead>
        {GROUPS.map(({ type, label }) => {
          const rows = accounts.filter((a) => a.type === type);
          if (rows.length === 0) return null;
          return (
            <tbody key={type}>
              <tr className="group-row">
                <th scope="rowgroup" colSpan={4}>
                  {label}
                </th>
              </tr>
              {rows.map((a) => {
                const isSelected = a.code === selected;
                return (
                  <tr key={a.code} className={isSelected ? 'selected' : undefined}>
                    <th scope="row">
                      <button
                        type="button"
                        className="account-button"
                        aria-pressed={isSelected}
                        onClick={() => onSelect(isSelected ? null : a.code)}
                      >
                        <span className="account-name">{a.name}</span>
                        <code className="account-code">{a.code}</code>
                      </button>
                    </th>
                    <td className="num">
                      <Amount raw={a.balance} currency={a.currency} />
                    </td>
                    <td className="num muted wide-only">
                      <Amount raw={a.debits} currency={a.currency} showCurrency={false} />
                    </td>
                    <td className="num muted wide-only">
                      <Amount raw={a.credits} currency={a.currency} showCurrency={false} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
