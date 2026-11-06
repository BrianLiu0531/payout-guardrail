import type { FastifyInstance } from 'fastify';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { intentChallenge, IntentError, POLICY_TEXT } from '@guardrail/core';
import { listAudit, verifyAudit } from './audit.js';
import { registerAuth, requireUser } from './auth.js';
import { ATTACKS, runAttack, simulateDeposit, type AttackDeps, type AttackId, type DemoBots } from './demo.js';
import { verifyIndexerSignature, type Deposits, type IndexerEvent } from './deposits.js';
import type { Reconciler } from './reconcile.js';
import { EXPENSE_ACCOUNTS, PayoutError, type Payouts } from './service.js';
import type { SignerPort } from './signerPort.js';

export interface PayoutRouteOptions {
  payouts: Payouts;
  signer: SignerPort;
  reconciler: Reconciler;
  demoMode: boolean;
  secureCookies?: boolean;
  bots?: DemoBots;
  attackDeps?: AttackDeps;
  /** Inbound deposits from base-usdc-indexer. */
  deposits?: { service: Deposits; webhookSecret: string };
}

const STATUS: Record<PayoutError['code'], number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  POLICY_DENIED: 422,
};

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } as const;
const obj = (required: string[], properties: Record<string, unknown>) => ({ type: 'object', required, additionalProperties: false, properties });

export function mapPayoutError(err: unknown): { status: number; body: unknown } | null {
  if (err instanceof PayoutError) return { status: STATUS[err.code], body: { error: { code: err.code, message: err.message, details: err.details } } };
  if (err instanceof IntentError) return { status: 400, body: { error: { code: 'VALIDATION', message: err.message } } };
  return null;
}

export function registerPayoutRoutes(app: FastifyInstance, opts: PayoutRouteOptions): void {
  const { payouts, signer, reconciler, demoMode } = opts;
  registerAuth(app, { payouts, demoMode, secureCookies: opts.secureCookies ?? false });

  app.get('/v1/config', async () => ({
    chainId: payouts.chain.chainId,
    token: payouts.chain.token,
    hotWallet: payouts.chain.hotWallet,
    custody: payouts.chain.custody,
    tokenDecimals: 6,
    expenseAccounts: EXPENSE_ACCOUNTS,
    demoMode,
    policy: POLICY_TEXT,
  }));

  // ---- payees ---------------------------------------------------------------------------

  app.get('/v1/payees', async () => ({ payees: await payouts.listPayees() }));

  app.post<{ Body: { name: string; address: string } }>(
    '/v1/payees',
    { schema: { body: obj(['name', 'address'], { name: { type: 'string', maxLength: 100 }, address: { type: 'string', maxLength: 42 } }) } },
    async (req, reply) => reply.status(201).send(await payouts.proposePayee(requireUser(req), req.body)),
  );

  // ---- intents --------------------------------------------------------------------------

  app.get<{ Querystring: { kind?: string; status?: string; limit?: number } }>(
    '/v1/intents',
    {
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['payout', 'payee_add', 'approver_add', 'breaker_reset'] },
            status: { type: 'string', maxLength: 20 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req) => ({ intents: await payouts.listIntents(req.query) }),
  );

  app.get<{ Params: { id: string } }>('/v1/intents/:id', { schema: { params: idParams } }, async (req) => {
    const intent = await payouts.getIntent(req.params.id);
    if (!intent) throw new PayoutError('NOT_FOUND', 'intent not found');
    return intent;
  });

  app.post<{ Body: { payeeId: string; amount: string; memo: string; expenseAccount: string } }>(
    '/v1/intents/payout',
    {
      schema: {
        body: obj(['payeeId', 'amount', 'expenseAccount'], {
          payeeId: { type: 'string', maxLength: 64 }, amount: { type: 'string', maxLength: 24 },
          memo: { type: 'string', maxLength: 200, default: '' }, expenseAccount: { type: 'string', maxLength: 100 },
        }),
      },
    },
    async (req, reply) => reply.status(201).send(await payouts.proposePayout(requireUser(req), { ...req.body, memo: req.body.memo ?? '' })),
  );

  app.post<{ Body: { reason: string } }>(
    '/v1/intents/breaker-reset',
    { schema: { body: obj(['reason'], { reason: { type: 'string', maxLength: 200 } }) } },
    async (req, reply) => reply.status(201).send(await payouts.proposeBreakerReset(requireUser(req), req.body.reason)),
  );

  /** WebAuthn options whose challenge is the intent hash: approving means signing exactly this intent. */
  app.post<{ Params: { id: string } }>('/v1/intents/:id/approval-options', { schema: { params: idParams } }, async (req) => {
    const user = requireUser(req);
    const intent = await payouts.getIntent(req.params.id);
    if (!intent) throw new PayoutError('NOT_FOUND', 'intent not found');
    const creds = (await payouts.credentialsOf(user.id)).filter((c) => c.enrolled && !c.software);
    if (creds.length === 0) throw new PayoutError('FORBIDDEN', 'you have no enrolled passkey on this account');
    const options = await generateAuthenticationOptions({
      rpID: payouts.webauthn.rpId,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })),
    });
    return { options: { ...options, challenge: intentChallenge(intent.hash) } };
  });

  app.post<{ Params: { id: string }; Body: { response: AuthenticationResponseJSON } }>(
    '/v1/intents/:id/approve',
    { schema: { params: idParams, body: obj(['response'], { response: { type: 'object' } }) } },
    async (req) => payouts.approve(requireUser(req), req.params.id, req.body.response.id, req.body.response),
  );

  app.post<{ Params: { id: string } }>('/v1/intents/:id/cancel', { schema: { params: idParams } }, async (req) =>
    payouts.cancel(requireUser(req), req.params.id),
  );

  // ---- security overview ----------------------------------------------------------------

  app.get('/v1/security', async () => {
    const [status, refusals, approvers, anchors, recon] = await Promise.all([
      signer.status(),
      signer.refusals(),
      signer.approvers(),
      signer.anchors(),
      reconciler.latest(),
    ]);
    const auditCheck = await verifyAudit(payouts.pool, anchors);
    return {
      signer: status,
      refusals: refusals.slice(0, 30),
      approvers,
      reconciliation: recon,
      audit: { ...auditCheck, anchors: anchors.length, lastAnchor: anchors.at(-1) ?? null },
    };
  });

  app.post('/v1/reconcile', async (req) => {
    requireUser(req);
    return reconciler.run();
  });

  app.get<{ Querystring: { limit?: number } }>(
    '/v1/audit',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } } } } },
    async (req) => ({ entries: await listAudit(payouts.pool, req.query.limit ?? 100) }),
  );

  // ---- inbound deposits from base-usdc-indexer --------------------------------------------

  if (opts.deposits) {
    const { service, webhookSecret } = opts.deposits;
    app.get('/v1/deposits', async () => ({ deposits: await service.list() }));

    // Authenticated by HMAC over the raw body, not by a session; needs the body exactly as sent.
    app.register(async (hook) => {
      hook.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (req, body, done) => {
        (req as { rawBody?: string }).rawBody = body as string;
        try {
          done(null, JSON.parse(body as string));
        } catch (err) {
          done(err as Error, undefined);
        }
      });
      const event = {
        type: 'object',
        required: ['eventId', 'type', 'chainId', 'txHash', 'logIndex', 'blockNumber', 'from', 'to', 'value'],
        properties: {
          eventId: { type: 'string', minLength: 1, maxLength: 300 },
          type: { type: 'string', enum: ['transfer.confirmed', 'transfer.reverted'] },
          chainId: { type: 'integer' },
          txHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
          logIndex: { type: 'integer', minimum: 0 },
          blockNumber: { type: 'integer', minimum: 0 },
          from: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
          to: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
          value: { type: 'string', pattern: '^[0-9]{1,78}$' },
        },
      } as const;
      hook.post<{ Body: { events: IndexerEvent[] } }>(
        '/v1/integrations/indexer',
        { schema: { body: { type: 'object', required: ['events'], properties: { events: { type: 'array', maxItems: 500, items: event } } } } },
        async (req, reply) => {
          const ok = verifyIndexerSignature(
            webhookSecret,
            req.headers['x-indexer-timestamp'] as string | undefined,
            req.headers['x-indexer-signature'] as string | undefined,
            (req as { rawBody?: string }).rawBody ?? '',
          );
          if (!ok) return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'bad or stale signature' } });
          return service.ingest(req.body.events);
        },
      );
    });
  }

  // ---- demo -----------------------------------------------------------------------------

  if (demoMode && opts.bots) {
    const bots = opts.bots;
    app.post<{ Body: { intentId: string; userId: string } }>(
      '/v1/demo/approve',
      { schema: { body: obj(['intentId', 'userId'], { intentId: { type: 'string', pattern: UUID }, userId: { type: 'string', maxLength: 32 } }) } },
      async (req) => {
        requireUser(req);
        const user = await payouts.getUser(req.body.userId);
        if (!user?.demo || !bots.has(user.id)) throw new PayoutError('FORBIDDEN', 'not a demo approver');
        const intent = await payouts.getIntent(req.body.intentId);
        if (!intent) throw new PayoutError('NOT_FOUND', 'intent not found');
        const a = bots.approval(user.id, intent.hash, payouts.webauthn.rpId, payouts.webauthn.origins[0]!);
        return payouts.approve(user, intent.id, a.credentialId, a.assertion);
      },
    );
  }

  if (demoMode && opts.attackDeps) {
    const deps = opts.attackDeps;
    app.get('/v1/demo/attacks', async () => ({ attacks: ATTACKS }));
    app.post<{ Body: { amount: string } }>(
      '/v1/demo/deposit',
      { schema: { body: obj(['amount'], { amount: { type: 'string', pattern: '^[0-9]{1,6}(\\.[0-9]{1,6})?$' } }) } },
      async (req) => {
        requireUser(req);
        return simulateDeposit(deps, req.body.amount);
      },
    );
    app.post<{ Params: { id: string } }>(
      '/v1/demo/attacks/:id/run',
      { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', enum: ATTACKS.map((a) => a.id) } } } } },
      async (req) => {
        requireUser(req);
        return runAttack(req.params.id as AttackId, deps);
      },
    );
  }
}
