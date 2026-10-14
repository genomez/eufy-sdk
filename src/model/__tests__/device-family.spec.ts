import {
  isIndoorCamera,
  isIndoorCamMini,
  isIndoorPanTiltS350,
  isOutdoorPanTilt,
  isFloodLight,
  isWiredDoorbell,
} from "../device-family.js";
import { DeviceType } from "../device-types.js";

const ctx = (deviceType?: number, model?: string) => ({ deviceType, model });

describe("device-family — classification", () => {
  it("isIndoorCamera covers indoor variants incl. PT / S350 / mini", () => {
    expect(isIndoorCamera(ctx(DeviceType.INDOOR_PT_CAMERA))).toBe(true); // 31 (T8410)
    expect(isIndoorCamera(ctx(DeviceType.INDOOR_COST_DOWN_CAMERA))).toBe(true); // mini
    expect(isIndoorCamera(ctx(DeviceType.INDOOR_PT_CAMERA_S350))).toBe(true);
    expect(isIndoorCamera(ctx(DeviceType.CAMERA2))).toBe(false); // 9 battery
    expect(isIndoorCamera(ctx(undefined))).toBe(false); // unknown → don't guess
  });

  it("mini / S350 / outdoor-PT / floodlight / doorbell predicates", () => {
    expect(isIndoorCamMini(ctx(DeviceType.INDOOR_COST_DOWN_CAMERA))).toBe(true);
    expect(isIndoorPanTiltS350(ctx(DeviceType.INDOOR_PT_CAMERA_S350))).toBe(true);
    expect(isIndoorPanTiltS350(ctx(DeviceType.INDOOR_PT_CAMERA))).toBe(false); // classic PT ≠ S350
    expect(isOutdoorPanTilt(ctx(DeviceType.OUTDOOR_PT_CAMERA))).toBe(true); // 48
    expect(isOutdoorPanTilt(ctx(DeviceType.SOLO_CAMERA_E30))).toBe(true); // 88
    expect(isFloodLight(ctx(DeviceType.FLOODLIGHT_CAMERA_8422))).toBe(true);
    expect(isWiredDoorbell(ctx(DeviceType.DOORBELL))).toBe(true); // 5
  });
});
