import { setScalar, setJson } from "../access.js";
import { CAMERA_CMD } from "../camera.js";
import { LIGHT_CMD } from "../light.js";
import type { CommandContext } from "../types.js";

const ctx = (channel = 0): CommandContext => ({ channel, codec: "camera", paramIds: new Set<number>() });

describe("command intent builders", () => {
  describe("setScalar", () => {
    it("defaults form to 'auto' (transport decides the encryption level)", () => {
      expect(setScalar(CAMERA_CMD.CAMERA_ENABLE, 1, ctx(2))).toEqual({
        kind: "set-param",
        param: CAMERA_CMD.CAMERA_ENABLE,
        value: 1,
        form: "auto",
        channel: 2,
      });
    });

    it("carries an explicit pinned form when the firmware requires a level", () => {
      expect(setScalar(CAMERA_CMD.DEV_LED_SWITCH, 0, ctx(), "int-string")).toMatchObject({
        kind: "set-param",
        form: "int-string",
        value: 0,
      });
      expect(setScalar(LIGHT_CMD.SPOTLIGHT_BRIGHTNESS, 50, ctx(), "direct-binary")).toMatchObject({
        kind: "set-param",
        form: "direct-binary",
        value: 50,
      });
    });
  });

  describe("setJson", () => {
    it("builds a set-json intent carrying the control payload", () => {
      expect(setJson(LIGHT_CMD.FLOODLIGHT_SWITCH, { time: 0, type: 2, value: 1 }, ctx(1))).toEqual({
        kind: "set-json",
        param: LIGHT_CMD.FLOODLIGHT_SWITCH,
        data: { time: 0, type: 2, value: 1 },
        channel: 1,
      });
    });
  });
});
