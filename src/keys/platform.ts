import type { Platform } from "./chord";

/** 'mac' on macOS, 'win' everywhere else (Windows key conventions also serve Linux). */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "win";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? "";
  return /mac|iphone|ipad/i.test(p) ? "mac" : "win";
}
