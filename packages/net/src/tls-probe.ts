/**
 * "Does this hostname serve a certificate a browser would accept?" — one TLS
 * handshake to a hostname somebody typed, and nothing else.
 *
 * M5-07 uses it after a custom domain's DNS checks out: the handshake is what
 * makes Caddy obtain the certificate on demand, and its outcome is what the
 * Domains tab shows as "certificate issued" or "certificate failed".
 *
 * The connection is made the way DOMAIN-RULES §13 requires of any connection to
 * a user-supplied host: the name is resolved once through
 * {@link resolvePublicHost}, which refuses private, loopback, link-local and
 * metadata addresses, and the socket goes to that one address with the name
 * kept for SNI and the certificate check. No byte of application data is sent
 * and none is read.
 */
import { type ConnectionOptions, connect, type PeerCertificate, type TLSSocket } from 'node:tls';
import { SafeFetchError } from './errors.js';
import { type ResolveHostPolicy, resolvePublicHost } from './resolve-host.js';

export type TlsProbeResult =
  /** The chain is trusted and names the host. */
  | { readonly status: 'valid'; readonly validTo: Date }
  /** A handshake happened, but the certificate is not one a browser would accept. */
  | { readonly status: 'invalid'; readonly code: string }
  /** No handshake: a blocked address, a DNS failure, a refused or silent port. */
  | { readonly status: 'unreachable'; readonly code: string };

/** The part of a TLS socket the probe reads. A test passes a double. */
export type ProbeSocket = Pick<
  TLSSocket,
  'once' | 'destroy' | 'authorized' | 'authorizationError' | 'getPeerCertificate'
>;

export interface TlsProbeOptions extends ResolveHostPolicy {
  /** Default 443. */
  readonly port?: number;
  /**
   * The whole budget, handshake included. Default 30 000: an on-demand
   * issuance holds the first handshake open while the ACME order completes.
   */
  readonly timeoutMs?: number;
  /** Replaces `tls.connect`; tests use it. */
  readonly connect?: (options: ConnectionOptions) => ProbeSocket;
}

export const DEFAULT_TLS_PROBE_TIMEOUT_MS = 30_000;
const HTTPS_PORT = 443;

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'network-error';
};

/**
 * The codes Node gives a handshake the certificate check refused: OpenSSL's
 * verification errors (`CERT_HAS_EXPIRED`, `DEPTH_ZERO_SELF_SIGNED_CERT`,
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`…) and Node's own host-name mismatch.
 */
const CERTIFICATE_ERROR = /CERT|SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)|ERR_TLS_CERT_ALTNAME_INVALID/;

export const isCertificateError = (code: string): boolean => CERTIFICATE_ERROR.test(code);

const validToOf = (certificate: PeerCertificate): Date => new Date(certificate.valid_to);

export async function probeTls(
  hostname: string,
  options: TlsProbeOptions = {},
): Promise<TlsProbeResult> {
  let address: string;
  try {
    ({ address } = await resolvePublicHost(hostname, options));
  } catch (error) {
    return {
      status: 'unreachable',
      code: error instanceof SafeFetchError ? error.code : 'dns-failure',
    };
  }

  const open = options.connect ?? connect;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TLS_PROBE_TIMEOUT_MS;

  return new Promise<TlsProbeResult>((resolve) => {
    let settled = false;
    // Verified by the socket: a certificate the chain check refuses fails the
    // handshake with a certificate error code, which is reported as `invalid`
    // with that code. Nothing ever talks to an unverified peer.
    const socket = open({
      host: address,
      port: options.port ?? HTTPS_PORT,
      servername: hostname,
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
    });

    const finish = (result: TlsProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ status: 'unreachable', code: 'timeout' });
    }, timeoutMs);

    socket.once('secureConnect', () => {
      if (!socket.authorized) {
        finish({ status: 'invalid', code: String(socket.authorizationError ?? 'untrusted') });
        return;
      }
      finish({ status: 'valid', validTo: validToOf(socket.getPeerCertificate()) });
    });
    socket.once('error', (error: unknown) => {
      const code = codeOf(error);
      finish(
        isCertificateError(code) ? { status: 'invalid', code } : { status: 'unreachable', code },
      );
    });
  });
}
