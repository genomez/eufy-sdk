/**
 * Example 01 — log in and list devices.
 *
 * The minimal end-to-end: log in (captcha/2FA handled in _client.ts) and print each device with its
 * resolved capabilities.
 *
 *   EUFY_EMAIL=you@example.com EUFY_PASSWORD=… node examples/01-login-list-devices.ts
 *
 * Requires `npm run build` first (imports the built lib from ../dist).
 */
import { loginClient } from "./_client.ts";

async function main(): Promise<void> {
  const eufy = await loginClient();

  const devices = await eufy.getDevices();
  for (const d of devices) {
    const dev = await eufy.getDevice(d.sn);
    console.log(`${d.sn}  ${d.name}  [${dev.codec}]  caps: ${dev.capabilities.join(", ")}`);
  }

  await eufy.disconnect();
}

main().catch((e: unknown) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
