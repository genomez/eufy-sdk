/**
 * Shared setup for the examples: construct the client and drive the login state machine.
 *
 * `login()` returns a discriminated result (no exceptions for the expected flow); step through it:
 *  - `captcha` → solve `result.image` and call `solveCaptcha(answer)` (here: from EUFY_CAPTCHA),
 *  - `2fa` → a code was sent; `submitVerifyCode(code)` (here: from EUFY_2FA).
 * A cached session (../.eufy-session.json) resolves straight to `ok`.
 *
 * Run with `node examples/01-login-list-devices.ts` (Node 24 strips types). Requires `npm run build`
 * first — the examples import the built lib from ../dist for real, typechecked types.
 */
import path from "node:path";
import { EufyMega, FileSessionStore, LoginStatus, type EufyMegaOptions } from "../dist/index.js";

/**
 * Construct a client and drive login to completion, returning the authenticated client. `overrides`
 * are merged over the env-based defaults so an example can pass tuning knobs (e.g. `p2pIdleMs`,
 * `cacheTtlMs`) without repeating the login boilerplate.
 */
export async function loginClient(overrides: Partial<EufyMegaOptions> = {}): Promise<EufyMega> {
  const eufy = new EufyMega({
    email: process.env.EUFY_EMAIL!,
    password: process.env.EUFY_PASSWORD!,
    countryCode: process.env.EUFY_COUNTRY || "GB",
    // Persist the token + ECDH key so re-runs skip login/2FA.
    store: new FileSessionStore(path.join(import.meta.dirname, "..", ".eufy-session.json")),
    ...overrides,
  });

  let r = await eufy.login();
  while (r.status !== LoginStatus.Ok) {
    if (r.status === LoginStatus.Captcha) {
      // r.image is a data:image/png;base64 4-char captcha — solve it out-of-band.
      if (!process.env.EUFY_CAPTCHA) throw new Error("captcha required — set EUFY_CAPTCHA");
      r = await eufy.solveCaptcha(process.env.EUFY_CAPTCHA);
    } else if (r.status === LoginStatus.TwoFactor) {
      // the code was emailed/texted (r.method says how).
      if (!process.env.EUFY_2FA) throw new Error("2FA required — set EUFY_2FA");
      r = await eufy.submitVerifyCode(process.env.EUFY_2FA);
    } else {
      throw new Error(`unexpected login status: ${JSON.stringify(r)}`); // exhaustive: never busy-loop
    }
  }
  return eufy;
}
