// Mock of UpdateBackend (contract/update.ts): the browser dev build does not update itself, like
// a dev build of the app. `?update=ready` in the URL fakes a downloaded 0.2.0 to show the UI.
import type { UpdateBackend, UpdateStatus } from "../types";
import { delay } from "./shared";

const ready = typeof location !== "undefined" && new URLSearchParams(location.search).get("update") === "ready";

const status = (): UpdateStatus =>
  ready
    ? { state: "ready", current: "0.1.0", version: "0.2.0", notes: "- mock release", checkedAt: new Date().toISOString() }
    : { state: "disabled", current: "0.1.0", message: "development build" };

export const updateMock: UpdateBackend = {
  updateStatus: () => delay(status()),
  updateCheck: () =>
    ready ? delay(status()) : Promise.reject({ code: 400, reason: "Invalid", message: "kns does not update itself: development build" }),
  updateInstall: () => Promise.reject({ code: 400, reason: "Invalid", message: "the mock cannot install updates" }),
};
