import { describe, it, expect, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import {
  listLightEffects,
  listAiSceneRecommendations,
  resolveLightEffect,
} from "../../transport/http/light-catalog.js";
import type { MegaHttpClient } from "../../transport/http/mega-client.js";

/**
 * `listLightEffects(client, …)` browses the gallery over discover/list + a scan of the effect-id window,
 * then batchget. eufy has no "list all" endpoint, so discover ids alone under-report — the id window is
 * what surfaces the full set. A host calls these with `eufy.api`; the specs drive that same client
 * (`eufy.api`) and stub `mega.request` (no network). A tiny `idRange` keeps the scanned id set
 * deterministic. They assert the union, the dedupe, and the `buildable` flag — which reports whether
 * the whole effect definition turns into wire fields, not merely that it carries a layer. The three
 * fixtures cover that: `Window Only` has no layers, `Ranged Interval` has one whose `[min,max]`
 * interval has no known packing, and `Presidents Day` serializes end to end.
 */
function makeClient() {
  return new EufyMega({ email: "t@example.com", password: "x" });
}

function stubRequest(eufy: EufyMega, impl: (service: string, path: string, body?: unknown) => unknown) {
  return vi
    .spyOn(
      (eufy as unknown as { mega: { request: (s: string, p: string, b?: unknown) => Promise<unknown> } }).mega,
      "request",
    )
    .mockImplementation(async (s: string, p: string, b?: unknown) => impl(s, p, b));
}

describe("light-effect catalogue (listLightEffects / listAiSceneRecommendations)", () => {
  it("unions discover ids with the scanned window, dedupes, and flags buildable", async () => {
    const eufy = makeClient();
    const request = stubRequest(eufy, (_s, path) => {
      if (path === "/app/light/discover/list") return { discover: [{ scene: { scene_id: 10474 } }] };
      if (path === "/app/light/lighteffect/batchget") {
        return {
          list: [
            {
              light_id: 10474,
              name: "Presidents Day",
              light_effect: [{ params: JSON.stringify({ layer: [{ current_layer_type: 1, colors: "ff0000" }] }) }],
            },
            { light_id: 10450, name: "Window Only", light_effect: [{ rgb_hex: "ff0000|00ff00" }] },
            {
              light_id: 10451,
              name: "Ranged Interval",
              light_effect: [
                {
                  params: JSON.stringify({
                    layer: [{ current_layer_type: 1, colors: "ff0000", interval_value: [1, 1] }],
                  }),
                },
              ],
            },
          ],
        };
      }
      return {};
    });

    // Tiny window so the scanned id set is deterministic: [10450, 10451] ∪ discover 10474.
    const effects = await listLightEffects(eufy.api, { idRange: [10450, 10451] });
    expect(effects).toEqual([
      { lightId: 10450, name: "Window Only", colors: "ff0000|00ff00", buildable: false },
      { lightId: 10451, name: "Ranged Interval", colors: undefined, buildable: false },
      { lightId: 10474, name: "Presidents Day", colors: undefined, buildable: true },
    ]);
    expect(request).toHaveBeenNthCalledWith(1, "light", "/app/light/discover/list", {});
    // batchget carries discover ids ∪ the window (deduped), not just discover.
    expect(request).toHaveBeenNthCalledWith(2, "light", "/app/light/lighteffect/batchget", {
      light_id: [10474, 10450, 10451],
    });
  });

  it("survives an entry whose params payload isn't an object", async () => {
    const eufy = makeClient();
    stubRequest(eufy, (_s, path) => {
      if (path === "/app/light/discover/list") return { discover: [] };
      if (path === "/app/light/lighteffect/batchget") {
        return {
          list: [
            { light_id: 10450, name: "Null Params", light_effect: [{ params: "null" }] },
            { light_id: 10451, name: "Array Params", light_effect: [{ params: "[1,2]" }] },
          ],
        };
      }
      return {};
    });
    // One malformed row must degrade to buildable:false, not reject the whole browse.
    expect(await listLightEffects(eufy.api, { idRange: [10450, 10451] })).toEqual([
      { lightId: 10450, name: "Null Params", colors: undefined, buildable: false },
      { lightId: 10451, name: "Array Params", colors: undefined, buildable: false },
    ]);
  });

  it("harvests scene/light ids nested under arbitrary categories (recursive walk)", async () => {
    const eufy = makeClient();
    const request = stubRequest(eufy, (_s, path) => {
      if (path === "/app/light/discover/list") {
        // Real-ish nesting: scenes buried under a category array, mixed scene_id / light_id keys —
        // the old single-path parse would drop all of these.
        return {
          discover: [
            { category: "Ambient", scenes: [{ scene_id: 20001, name: "Forest Mystery" }] },
            { category: "Dreamy", items: [{ list: [{ light_id: 20002, name: "Dreamy Stars" }] }] },
          ],
        };
      }
      if (path === "/app/light/lighteffect/batchget") {
        return {
          list: [
            { light_id: 20001, name: "Forest Mystery", light_effect: [{ params: JSON.stringify({ layer: [{}] }) }] },
            { light_id: 20002, name: "Dreamy Stars", light_effect: [{ params: JSON.stringify({ layer: [{}] }) }] },
          ],
        };
      }
      return {};
    });

    const effects = await listLightEffects(eufy.api, { idRange: [1, 0] }); // empty window → ids come only from discover
    expect(effects.map((e) => e.name)).toEqual(["Forest Mystery", "Dreamy Stars"]);
    expect(request).toHaveBeenNthCalledWith(2, "light", "/app/light/lighteffect/batchget", {
      light_id: [20001, 20002],
    });
  });

  it("lists AI ambient-scene keywords from the aigc endpoint (no lightId)", async () => {
    const eufy = makeClient();
    const request = stubRequest(eufy, (_s, path) => {
      if (path === "/app/light/aigc/recommend/list") {
        return { list: [{ keywords: "Enchanting Starry Night" }, { keywords: "Moonlit Serenity" }, { keywords: "" }] };
      }
      return {};
    });
    const scenes = await listAiSceneRecommendations(eufy.api, { sn: "T8000P0000000000" });
    expect(scenes).toEqual(["Enchanting Starry Night", "Moonlit Serenity"]); // empty keyword dropped
    expect(request).toHaveBeenCalledWith("light", "/app/light/aigc/recommend/list", {
      region: "eu",
      sn: "T8000P0000000000",
    });
  });

  it("resolveLightEffect throws (never substitutes a neighbour) when the exact id isn't returned", async () => {
    // batchget answered, but with a DIFFERENT id than asked for — must not fall back to it.
    const mega = {
      request: async () => ({
        list: [{ light_id: 99999, name: "Other", light_effect: [{ params: JSON.stringify({ layer: [{}] }) }] }],
      }),
    } as unknown as MegaHttpClient;
    await expect(resolveLightEffect(mega, 10640)).rejects.toThrow(/not found in the catalog/i);
  });

  it("still queries the window even when discover returns nothing", async () => {
    const eufy = makeClient();
    const request = stubRequest(eufy, (_s, path) => {
      if (path === "/app/light/discover/list") return { discover: [] };
      if (path === "/app/light/lighteffect/batchget") return { list: [] };
      return {};
    });
    expect(await listLightEffects(eufy.api, { idRange: [10450, 10451] })).toEqual([]);
    // Discover empty no longer short-circuits — the window scan still runs.
    expect(request).toHaveBeenNthCalledWith(2, "light", "/app/light/lighteffect/batchget", {
      light_id: [10450, 10451],
    });
  });
});
