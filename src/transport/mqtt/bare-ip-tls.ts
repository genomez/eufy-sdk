/**
 * TLS shape for dialling an AIoT broker instance by bare IP.
 *
 * The broker hostname fronts several independent backend instances that do not share subscribe/publish
 * routing, so both the pinned transport and the reachability probe in `./broker-discovery.ts` connect
 * to one instance's IP directly rather than letting DNS pick. That is the only reason a bare-IP dial
 * exists here, and it is what makes this fragment necessary: Node matches the presented certificate
 * against the name passed to `connect`, which for an IP dial is the IP, and the broker's certificate
 * names the hostname. `servername` keeps SNI on that hostname so the instance answers with the same
 * certificate a DNS-resolved connect would have got, and the check is then run against it — Node's own
 * matcher, given the name the server answered for. Nothing is relaxed or reimplemented.
 *
 * Both call sites need the identical recipe, so it lives in one place.
 */
import tls from "node:tls";

/**
 * The mTLS identity and server-verification options for one bare-IP broker dial.
 *
 * `rejectUnauthorized` is deliberately absent as a caller-tunable: there is no supported way to turn
 * server verification off, because the transport carries a per-user client certificate and the
 * account's device command traffic.
 * @internal
 */
export interface BareIpTlsOptions {
  servername: string;
  cert: string;
  key: string;
  ca: string;
  rejectUnauthorized: true;
  checkServerIdentity: (hostname: string, cert: tls.PeerCertificate) => Error | undefined;
}

/**
 * Build the TLS options for reaching `hostname`'s broker at a specific instance IP.
 *
 * `ca` REPLACES Node's trust store rather than extending it. It arrives per-user from the cloud's
 * `get_user_mqtt_info` response over an already-verified HTTPS channel, alongside the client
 * certificate and key it is used with, so trusting exactly that one root is both sound and strictly
 * narrower than trusting every public CA.
 * @internal
 */
export function bareIpTlsOptions(identity: {
  hostname: string;
  cert: string;
  key: string;
  ca: string;
}): BareIpTlsOptions {
  return {
    servername: identity.hostname,
    cert: identity.cert,
    key: identity.key,
    ca: identity.ca,
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(identity.hostname, cert),
  };
}
