import Fastify, { type FastifyInstance } from 'fastify';
import {
  LedgerError,
  type Balance,
  type IntegrityProblem,
  type Ledger,
  type LedgerErrorCode,
  type Transaction,
} from '@guardrail/ledger';
import { CURRENCIES } from './currencies.js';
import type {
  AccountDto,
  ErrorDto,
  IntegrityProblemDto,
  TransactionDto,
  TransactionPageDto,
  TrialBalanceDto,
  VerifyDto,
} from './dto.js';

export interface AppOptions {
  ledger: Ledger;
  logger?: boolean;
  /** verify() scans every entry; results younger than this are reused. Default 5 s. */
  verifyCacheMs?: number;
}

const STATUS: Record<LedgerErrorCode, number> = {
  VALIDATION: 400,
  UNKNOWN_ACCOUNT: 404,
  NOT_FOUND: 404,
  ACCOUNT_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INSUFFICIENT_BALANCE: 409,
  ALREADY_REVERSED: 409,
};

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/**
 * Read-only ledger API. Nothing here can post: in this system money only moves
 * through approved payout intents (phase 2), never through a raw ledger endpoint.
 */
export function buildApp({ ledger, logger = false, verifyCacheMs = 5_000 }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger,
    // Reject unknown parameters instead of silently dropping them (Fastify's default).
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof LedgerError) {
      const body: ErrorDto = { error: { code: err.code, message: err.message, details: err.details } };
      return reply.status(STATUS[err.code]).send(body);
    }
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (e.validation) {
      const body: ErrorDto = { error: { code: 'VALIDATION', message: e.message ?? 'invalid request' } };
      return reply.status(400).send(body);
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'BAD_REQUEST', message: e.message ?? 'bad request' } });
    }
    req.log.error(err);
    // Never leak internals (SQL, stack traces) to the client.
    const body: ErrorDto = { error: { code: 'INTERNAL', message: 'internal error' } };
    return reply.status(500).send(body);
  });

  app.setNotFoundHandler((_req, reply) => {
    const body: ErrorDto = { error: { code: 'NOT_FOUND', message: 'route not found' } };
    return reply.status(404).send(body);
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/v1/currencies', async () => ({ currencies: CURRENCIES }));

  app.get('/v1/ledger/accounts', async () => {
    const [accounts, balances] = await Promise.all([ledger.listAccounts(), ledger.listBalances()]);
    const byCode = new Map(balances.map((b) => [b.account, b]));
    const out: AccountDto[] = accounts.map((a) => {
      const b = byCode.get(a.code) as Balance;
      return {
        code: a.code,
        name: a.name,
        type: a.type,
        currency: a.currency,
        allowNegative: a.allowNegative,
        debits: b.debits.toString(),
        credits: b.credits.toString(),
        balance: b.balance.toString(),
      };
    });
    return { accounts: out };
  });

  app.get('/v1/ledger/trial-balance', async () => {
    const rows = await ledger.trialBalance();
    const out: TrialBalanceDto[] = rows.map((r) => ({
      currency: r.currency,
      debits: r.debits.toString(),
      credits: r.credits.toString(),
      balanced: r.balanced,
    }));
    return { trialBalance: out };
  });

  app.get<{ Querystring: { account?: string; limit?: number; before?: string } }>(
    '/v1/ledger/transactions',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            account: { type: 'string', minLength: 1, maxLength: 100 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
            before: { type: 'string', pattern: '^[0-9]{1,19}$' },
          },
        },
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 25;
      if (req.query.account !== undefined) await ledger.getAccount(req.query.account); // 404 for unknown accounts
      const txs = await ledger.listTransactions({ account: req.query.account, limit, beforeSeq: req.query.before });
      const last = txs[txs.length - 1];
      const page: TransactionPageDto = {
        transactions: txs.map(toTransactionDto),
        nextCursor: txs.length === limit && last ? last.seq : null,
      };
      return page;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/ledger/transactions/:id',
    { schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: UUID } }, required: ['id'] } } },
    async (req) => toTransactionDto(await ledger.getTransaction(req.params.id.toLowerCase())),
  );

  // Single-flight + short cache: a burst of page loads triggers one full scan.
  let cached: { at: number; result: Promise<VerifyDto> } | null = null;
  app.get('/v1/ledger/verify', async () => {
    const now = Date.now();
    if (!cached || now - cached.at > verifyCacheMs) {
      const result = ledger.verify().then((problems): VerifyDto => ({
        ok: problems.length === 0,
        problems: problems.map(toProblemDto),
        checkedAt: new Date().toISOString(),
      }));
      cached = { at: now, result };
      result.catch(() => {
        cached = null;
      });
    }
    return cached.result;
  });

  return app;
}

function toTransactionDto(t: Transaction): TransactionDto {
  return {
    id: t.id,
    seq: t.seq,
    idempotencyKey: t.idempotencyKey,
    description: t.description,
    metadata: t.metadata,
    reverses: t.reverses,
    reversedBy: t.reversedBy,
    effectiveAt: t.effectiveAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
    entries: t.entries.map((e) => ({
      id: e.id,
      account: e.account,
      currency: e.currency,
      direction: e.direction,
      amount: e.amount.toString(),
    })),
  };
}

function toProblemDto(p: IntegrityProblem): IntegrityProblemDto {
  switch (p.kind) {
    case 'balance_mismatch':
      return {
        kind: p.kind,
        account: p.account,
        stored: { debits: p.stored.debits.toString(), credits: p.stored.credits.toString() },
        fromEntries: { debits: p.fromEntries.debits.toString(), credits: p.fromEntries.credits.toString() },
      };
    case 'negative_balance':
      return { kind: p.kind, account: p.account, balance: p.balance.toString() };
    default:
      return p;
  }
}
