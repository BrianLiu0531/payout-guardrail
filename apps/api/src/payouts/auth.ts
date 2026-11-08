import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { audit } from './audit.js';
import { PayoutError, type Payouts, type User } from './service.js';

export const SESSION_COOKIE = 'guardrail_session';
const SESSION_HOURS = 12;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface AuthOptions {
  payouts: Payouts;
  demoMode: boolean;
  secureCookies: boolean;
  requestOrigins?: string[];
}

export function registerAuth(app: FastifyInstance, { payouts, demoMode, secureCookies, requestOrigins }: AuthOptions): void {
  const { pool, webauthn } = payouts;
  const allowedOrigins = requestOrigins ?? webauthn.origins;
  app.decorateRequest('user', null);

  // Cross-site requests are refused outright; SameSite=Strict on the cookie is the second layer.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) {
        req.log.warn({ origin, allowed: allowedOrigins }, 'cross-origin request refused');
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'cross-origin request refused' } });
      }
    }
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.role, u.demo FROM payouts.sessions s JOIN payouts.users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    req.user = rows[0] ?? null;
  });

  async function startSession(reply: FastifyReply, userId: string): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO payouts.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
      [sha256(token), userId, SESSION_HOURS],
    );
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookies, maxAge: SESSION_HOURS * 3600,
    });
  }

  async function takeChallenge(id: string, purpose: 'register' | 'login'): Promise<{ challenge: string; data: Record<string, string> }> {
    const { rows } = await pool.query(
      'DELETE FROM payouts.challenges WHERE id = $1 AND purpose = $2 AND expires_at > now() RETURNING challenge, data',
      [id, purpose],
    );
    if (!rows[0]) throw new PayoutError('UNAUTHENTICATED', 'challenge expired or already used');
    return rows[0];
  }

  async function saveChallenge(challenge: string, purpose: 'register' | 'login', data: Record<string, string> = {}): Promise<string> {
    await pool.query('DELETE FROM payouts.challenges WHERE expires_at < now()');
    const { rows } = await pool.query(
      "INSERT INTO payouts.challenges (challenge, purpose, data, expires_at) VALUES ($1, $2, $3, now() + interval '5 minutes') RETURNING id",
      [challenge, purpose, data],
    );
    return rows[0].id;
  }

  app.get('/v1/auth/me', async (req) => ({
    user: req.user,
    passkeys: req.user ? await payouts.credentialsOf(req.user.id) : [],
    demoMode,
  }));

  app.get('/v1/auth/users', async () => ({ users: await payouts.listUsers() }));

  if (demoMode) {
    // Demo only: sign in as a seeded demo user without a passkey. Approvals still need a
    // passkey signature (the demo users' keys are held by the server and clearly marked).
    app.post<{ Body: { userId: string } }>(
      '/v1/auth/demo-login',
      { schema: { body: { type: 'object', required: ['userId'], additionalProperties: false, properties: { userId: { type: 'string', maxLength: 32 } } } } },
      async (req, reply) => {
        const user = await payouts.getUser(req.body.userId);
        if (!user?.demo) throw new PayoutError('FORBIDDEN', 'only demo users can be signed in to without a passkey');
        await startSession(reply, user.id);
        await audit(pool, user.id, 'session.demo_login', null);
        return { user };
      },
    );
  }

  app.post('/v1/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await pool.query('DELETE FROM payouts.sessions WHERE token_hash = $1', [sha256(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---- passkey registration: creates an approver whose passkey still needs enrolling ----

  app.post<{ Body: { name: string; userId: string } }>(
    '/v1/auth/register/options',
    {
      schema: {
        body: {
          type: 'object', required: ['name', 'userId'], additionalProperties: false,
          properties: { name: { type: 'string', minLength: 2, maxLength: 60 }, userId: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{1,31}$' } },
        },
      },
    },
    async (req) => {
      if (await payouts.getUser(req.body.userId)) throw new PayoutError('CONFLICT', 'that user id is taken');
      const options = await generateRegistrationOptions({
        rpName: webauthn.rpName,
        rpID: webauthn.rpId,
        userName: req.body.userId,
        userDisplayName: req.body.name,
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        supportedAlgorithmIDs: [-7, -257],
      });
      const challengeId = await saveChallenge(options.challenge, 'register', { userId: req.body.userId, name: req.body.name });
      return { challengeId, options };
    },
  );

  app.post<{ Body: { challengeId: string; response: RegistrationResponseJSON } }>(
    '/v1/auth/register/verify',
    { schema: { body: { type: 'object', required: ['challengeId', 'response'], additionalProperties: false, properties: { challengeId: { type: 'string', format: 'uuid' }, response: { type: 'object' } } } } },
    async (req, reply) => {
      const { challenge, data } = await takeChallenge(req.body.challengeId, 'register');
      const result = await verifyRegistrationResponse({
        response: req.body.response,
        expectedChallenge: challenge,
        expectedOrigin: webauthn.origins,
        expectedRPID: webauthn.rpId,
        requireUserVerification: true,
      }).catch((err: Error) => {
        throw new PayoutError('UNAUTHENTICATED', `passkey registration failed: ${err.message}`);
      });
      if (!result.verified) throw new PayoutError('UNAUTHENTICATED', 'passkey registration failed');
      const cred = result.registrationInfo.credential;

      const c = await pool.connect();
      let intentId: string;
      try {
        await c.query('BEGIN');
        const ins = await c.query("INSERT INTO payouts.users (id, name, role) VALUES ($1, $2, 'approver') ON CONFLICT DO NOTHING", [data.userId, data.name]);
        if (ins.rowCount !== 1) throw new PayoutError('CONFLICT', 'that user id is taken');
        await c.query(
          'INSERT INTO payouts.credentials (id, user_id, public_key, counter, transports) VALUES ($1, $2, $3, $4, $5)',
          [cred.id, data.userId, Buffer.from(cred.publicKey), cred.counter, cred.transports ?? []],
        );
        await audit(c, data.userId!, 'passkey.registered', cred.id);
        const user: User = { id: data.userId!, name: data.name!, role: 'approver', demo: false };
        intentId = await payouts.proposeApprover(user, { id: cred.id, publicKey: cred.publicKey }, c);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
      await startSession(reply, data.userId!);
      return { user: await payouts.getUser(data.userId!), enrollmentIntent: intentId };
    },
  );

  // ---- passkey sign-in ------------------------------------------------------------------

  app.post('/v1/auth/login/options', async () => {
    const options = await generateAuthenticationOptions({ rpID: webauthn.rpId, userVerification: 'required' });
    return { challengeId: await saveChallenge(options.challenge, 'login'), options };
  });

  app.post<{ Body: { challengeId: string; response: AuthenticationResponseJSON } }>(
    '/v1/auth/login/verify',
    { schema: { body: { type: 'object', required: ['challengeId', 'response'], additionalProperties: false, properties: { challengeId: { type: 'string', format: 'uuid' }, response: { type: 'object' } } } } },
    async (req, reply) => {
      const { challenge } = await takeChallenge(req.body.challengeId, 'login');
      const { rows } = await pool.query('SELECT id, user_id, public_key, counter FROM payouts.credentials WHERE id = $1 AND NOT software', [req.body.response.id]);
      const cred = rows[0];
      if (!cred) throw new PayoutError('UNAUTHENTICATED', 'unknown passkey');
      const result = await verifyAuthenticationResponse({
        response: req.body.response,
        expectedChallenge: challenge,
        expectedOrigin: webauthn.origins,
        expectedRPID: webauthn.rpId,
        requireUserVerification: true,
        credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: Number(cred.counter) },
      }).catch(() => ({ verified: false }) as const);
      if (!result.verified) throw new PayoutError('UNAUTHENTICATED', 'passkey sign-in failed');
      await pool.query('UPDATE payouts.credentials SET counter = $2 WHERE id = $1', [cred.id, result.authenticationInfo.newCounter]);
      await startSession(reply, cred.user_id);
      await audit(pool, cred.user_id, 'session.passkey_login', null);
      return { user: await payouts.getUser(cred.user_id) };
    },
  );
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new PayoutError('UNAUTHENTICATED', 'sign in first');
  return req.user;
}
