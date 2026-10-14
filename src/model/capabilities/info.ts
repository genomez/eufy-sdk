import type { CapabilityActions, CapabilityModule, CommandContext } from "./types.js";
import type { MemberDeps } from "./members.js";

/**
 * `info` — per-device identity metadata.
 * UNIVERSAL (every device has it) and READ-ONLY: it dispatches no command and touches no
 * `CommandSink` — its `actions()` factory just projects the already-resolved {@link CommandContext}
 * into a stable {@link DeviceInfo} object.
 *
 * `manufacturer` is the constant "eufy" (Anker AIoT) — there is no per-device manufacturer field on
 * the mega wire. Everything else is sourced by the facade off the cloud device record into `ctx`
 * (transport-independent — no P2P/MQTT): `firmwareVersion`/`hardwareVersion` from `main_sw_version` /
 * `main_hw_version` (app labels `firmware_main_version` / `hardware_version`), `firmwareSubVersion`
 * from `sec_sw_version`, `macAddress` from `wifi_mac`, `updateAvailable` from `needUpdate`. All are
 * OPTIONAL (`undefined`/absent when the record doesn't carry them, never a fabricated value).
 *
 * @module model/capabilities/info
 */

/** eufy is an Anker AIoT brand; there is no per-device manufacturer field on the wire. */
const MANUFACTURER = "eufy";

/**
 * Per-device identity metadata — the object returned by `dev.info()`. The standard identity fields
 * (manufacturer / model / serial / name / firmware / hardware version); `deviceType` is diagnostic.
 */
export interface DeviceInfo {
  /** Always "eufy" (Anker AIoT) — no per-device manufacturer on the wire. */
  manufacturer: string;
  /** Model / T-code (e.g. "T8410"), when known. */
  model?: string;
  /** Full device serial number, when known. */
  serialNumber?: string;
  /** Display name, when known. */
  name?: string;
  /** eufy numeric DeviceType, when known (diagnostic). */
  deviceType?: number;
  /** Firmware (main software) version (`main_sw_version`), when the device record carries it. */
  firmwareVersion?: string;
  /** Hardware version (`main_hw_version`), when the device record carries it. */
  hardwareVersion?: string;
  /** Secondary/sub firmware version (`sec_sw_version`, app label `firmware_sub_version`), when present. */
  firmwareSubVersion?: string;
  /** Wi-Fi MAC address (`wifi_mac`, app label `mac_address`), when present. */
  macAddress?: string;
  /** Whether the device reports a firmware update is available (`needUpdate`). */
  updateAvailable?: boolean;
}

/** Project the resolved {@link CommandContext} into a {@link DeviceInfo}. Pure; no I/O. */
function buildDeviceInfo(ctx: CommandContext): DeviceInfo {
  return {
    manufacturer: MANUFACTURER,
    model: ctx.model,
    serialNumber: ctx.serial,
    name: ctx.name,
    deviceType: ctx.deviceType,
    firmwareVersion: ctx.firmwareVersion, // main_sw_version off the record (undefined if absent)
    hardwareVersion: ctx.hardwareVersion, // main_hw_version off the record (undefined if absent)
    firmwareSubVersion: ctx.firmwareSubVersion, // sec_sw_version off the record
    macAddress: ctx.macAddress, // wifi_mac off the record
    updateAvailable: ctx.updateAvailable, // needUpdate flag off the record
  };
}

export const INFO: CapabilityModule = {
  capability: "info",
  line: "any",
  description: "Per-device identity metadata (manufacturer/model/serial/name) for host registries.",
  // Contributes no wire properties — identity comes from the resolved context, not a param.
  properties: [],
  // UNIVERSAL: every device has identity metadata. The `detect` escape hatch matches all devices,
  // keeping it namespace-agnostic across the security + vacuum families (not tied to a codec baseline).
  detection: { detect: () => true },
  // Read-only: no buildCommand, no events. `actions()` ignores sink/media/ff09Settings and returns
  // the DeviceInfo object directly. `info` is a DATA capability: its consumer type is `DeviceInfo`,
  // declared in `DeviceActionMap` (from which `dev.info(): DeviceInfo | undefined` is derived), so
  // the returned value IS a `DeviceInfo` at runtime. The shared `CapabilityActions` base models
  // method-bags (control capabilities), not data objects — so we assert here, in the one data
  // capability, rather than widen that base (and lose call-safety) for every control module.
  actions({ ctx }: MemberDeps): CapabilityActions {
    return buildDeviceInfo(ctx) as unknown as CapabilityActions;
  },
};
