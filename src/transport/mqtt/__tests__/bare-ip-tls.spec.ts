import { describe, it, expect } from "vitest";
import tls from "node:tls";
import { bareIpTlsOptions } from "../bare-ip-tls.js";

/**
 * The bare-IP dial's server-identity policy, exercised against Node's real `tls.checkServerIdentity`.
 *
 * No socket and no fixtures: `checkServerIdentity` is a pure function of a hostname and a peer
 * certificate, so a hand-built certificate shape drives the actual matcher the TLS handshake would
 * call. That covers the part that is ours — WHICH name the certificate is verified against — while
 * chain verification stays Node's, enabled by `rejectUnauthorized`.
 */
const HOSTNAME = "aiot-mqtt-us.example.invalid";
const INSTANCE_IP = "198.51.100.7";

const IDENTITY = { hostname: HOSTNAME, cert: "client-cert", key: "client-key", ca: "server-ca" };

/** A peer certificate naming `name` in its SAN list, in the shape `checkServerIdentity` reads. */
function certFor(name: string): tls.PeerCertificate {
  return { subject: { CN: name }, subjectaltname: `DNS:${name}` } as unknown as tls.PeerCertificate;
}

describe("bareIpTlsOptions", () => {
  it("verifies the server against the broker hostname, carrying the client certificate", () => {
    expect(bareIpTlsOptions(IDENTITY)).toMatchObject({
      servername: HOSTNAME,
      cert: "client-cert",
      key: "client-key",
      ca: "server-ca",
      rejectUnauthorized: true,
    });
  });

  it("accepts the broker's certificate even though the socket dialled an IP", () => {
    expect(bareIpTlsOptions(IDENTITY).checkServerIdentity(INSTANCE_IP, certFor(HOSTNAME))).toBeUndefined();
  });

  it("is why the check cannot be left to Node's default: the dialled IP does not match that certificate", () => {
    expect(tls.checkServerIdentity(INSTANCE_IP, certFor(HOSTNAME))).toBeInstanceOf(Error);
  });

  it("rejects a certificate for any other name, whatever the socket dialled", () => {
    const wrong = bareIpTlsOptions(IDENTITY).checkServerIdentity(INSTANCE_IP, certFor("attacker.example.invalid"));
    expect(wrong).toBeInstanceOf(Error);
    expect((wrong as Error).message).toMatch(/does not match/);
  });
});
