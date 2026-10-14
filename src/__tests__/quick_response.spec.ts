import { parseQuickResponses } from "../index.js";

/**
 * Quick-response list parsing (pure/offline). The records below are the EXACT `voice_list` found
 * verbatim in the live-capture heap (`scratch/quickresponse-capture/m_dalvik.bin`, the
 * `{"cmd":6237,"payload":{"voice_list":[…]}}` reply). The classification we assert is that
 * predefined/eufy responses live under `/system/snd/` and user-recorded ones under `/user/…`.
 */
const HEAP_VOICE_LIST = [
  { voice_id: 1, voice_name: "Excuse me,can I help you", voice_path: "/system/snd//QuickReply_1.snd" },
  { voice_id: 2, voice_name: "Please leave it at the door", voice_path: "/system/snd//QuickReply_2.snd" },
  { voice_id: 3, voice_name: "We will be right there", voice_path: "/system/snd//QuickReply_3.snd" },
  { voice_id: 100, voice_name: "hello", voice_path: "/user/quick_respone_diy//QuickReply_4.aac" },
  { voice_id: 101, voice_name: "booo", voice_path: "/user/quick_respone_diy//QuickReply_5.aac" },
];

describe("parseQuickResponses", () => {
  it("maps every heap record to a typed QuickResponse", () => {
    const list = parseQuickResponses(HEAP_VOICE_LIST);
    expect(list).toHaveLength(5);
    expect(list[1]).toEqual({
      voiceId: 2,
      name: "Please leave it at the door",
      path: "/system/snd//QuickReply_2.snd",
      custom: false,
    });
    expect(list[3]).toEqual({
      voiceId: 100,
      name: "hello",
      path: "/user/quick_respone_diy//QuickReply_4.aac",
      custom: true,
    });
  });

  it("classifies /system/snd/ paths as predefined (custom=false)", () => {
    const list = parseQuickResponses(HEAP_VOICE_LIST);
    const predefined = list.filter((r) => !r.custom);
    expect(predefined.map((r) => r.voiceId)).toEqual([1, 2, 3]);
  });

  it("classifies /user/… paths as custom (custom=true)", () => {
    const list = parseQuickResponses(HEAP_VOICE_LIST);
    const custom = list.filter((r) => r.custom);
    expect(custom.map((r) => r.voiceId)).toEqual([100, 101]);
  });

  it("bases custom on the path prefix, not the id range", () => {
    // A low id under /user/ is custom; a high id under /system/snd/ is predefined.
    const list = parseQuickResponses([
      { voice_id: 4, voice_name: "diy low id", voice_path: "/user/quick_respone_diy//QuickReply_9.aac" },
      { voice_id: 200, voice_name: "system high id", voice_path: "/system/snd//QuickReply_9.snd" },
    ]);
    expect(list[0].custom).toBe(true);
    expect(list[1].custom).toBe(false);
  });

  it("tolerates missing/blank fields and an empty list", () => {
    expect(parseQuickResponses([])).toEqual([]);
    const [r] = parseQuickResponses([{ voice_id: 7 }]);
    expect(r).toEqual({ voiceId: 7, name: "", path: "", custom: true });
  });
});
