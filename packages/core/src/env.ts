/**
 * Where the browser sees the app. Locally that is http://localhost:5173 (dev) and :4173
 * (preview). In GitHub Codespaces it is https://<codespace>-5173.<forwarding domain>, and
 * WebAuthn needs that exact origin, with its host as the relying party id.
 */
export function webOrigins(env: NodeJS.ProcessEnv = process.env): { rpId: string; origins: string[] } {
  if (env.WEBAUTHN_ORIGINS || env.WEBAUTHN_RP_ID) {
    return {
      rpId: env.WEBAUTHN_RP_ID ?? 'localhost',
      origins: (env.WEBAUTHN_ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(','),
    };
  }
  if (env.CODESPACE_NAME && env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    const host = `${env.CODESPACE_NAME}-5173.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
    return { rpId: host, origins: [`https://${host}`] };
  }
  return { rpId: 'localhost', origins: ['http://localhost:5173', 'http://localhost:4173'] };
}

/**
 * Origin headers the API accepts on writes. Usually the same as the WebAuthn origins, but the
 * Codespaces port forwarder rewrites the page's own Origin header to https://localhost:<port>
 * on the way in (the passkey's signed clientData still carries the real origin, so WebAuthn
 * keeps using webOrigins). Other origins are passed through and still refused.
 */
export function requestOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const { origins } = webOrigins(env);
  const forwarded = !env.WEBAUTHN_ORIGINS && !env.WEBAUTHN_RP_ID && env.CODESPACE_NAME && env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  return forwarded ? [...origins, 'https://localhost:5173'] : origins;
}
