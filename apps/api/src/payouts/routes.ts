import type { FastifyInstance } from 'fastify';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { intentChallenge, IntentError, POLICY_TEXT } from '@guardrail/core';
import { listAudit, verifyAudit } from './audit.js';
import { registerAuth, requireUser } from './auth.js';
import { ATTACKS, runAttack, type AttackDeps, type AttackId, type DemoBots } from './demo.js';
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
