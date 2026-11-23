import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings";

describe("sanitizeSettings", () => {
  it("returns defaults for garbage", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("x")).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({ theme: "claude", mode: "system", zoom: 100, rowHeight: 20, killEnabled: false });
  });

  it("clamps enums and ranges and keeps valid fields", () => {
    const s = sanitizeSettings({
      theme: "rosa",
      mode: "lys",
      zoom: 120,
      rowHeight: 28,
      singleKeys: "no",
      k9sMode: true,
      mono: "jetbrains",
      logBufferLines: 5,
      termScrollback: 1e9,
      contexts: { default: { protected: true, readOnly: "yes" }, broken: 3 },
    });
    expect(s).toEqual({
      ...DEFAULT_SETTINGS,
      mode: "lys",
      rowHeight: 28,
      k9sMode: true,
      mono: "jetbrains",
      logBufferLines: 1000,
      termScrollback: 100000,
      contexts: { default: { protected: true, readOnly: false }, broken: { protected: false, readOnly: false } },
    });
  });
});

describe("feature settings (plan-features §2.10a)", () => {
  it("defaults and clamps the new fields", () => {
    const d = sanitizeSettings({});
    expect(d).toMatchObject({ clipboardClearSeconds: 60, logsStructured: true, agentForwardIdleMinutes: 15 });
    expect(d.debugImages.length).toBeGreaterThan(0);
    const s = sanitizeSettings({ clipboardClearSeconds: -5, agentForwardIdleMinutes: 1e9, logsStructured: "no", debugImages: ["ok:1", "bad image", 3, "ok:1"] });
    expect(s).toMatchObject({ clipboardClearSeconds: 0, agentForwardIdleMinutes: 1440, logsStructured: true, debugImages: ["ok:1"] });
    expect(sanitizeSettings({ debugImages: [] }).debugImages).toEqual(DEFAULT_SETTINGS.debugImages);
  });
});
