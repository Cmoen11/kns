// Mock of the native save dialog that Rust opens (tauri-plugin-dialog) for env export and pack save.
// No window.confirm/prompt: it resolves a fake path, or null when the next answer was set to
// cancel (`window.__knsMock.saveDialog("cancel")`, dev only). "repo" picks a path inside a
// (pretend) git work tree that is not git-ignored, so the export asks for the typed confirm.

export type SaveAnswer = "save" | "cancel" | "repo";
let next: SaveAnswer = "save";

const WORK = "C:\\Users\\mock\\work\\";
export const MOCK_REPO = `${WORK}repo`;

/** The next mock save dialog answers this, once. */
export function setNextSaveDialog(answer: SaveAnswer): void {
  next = answer;
}

/** A mock path inside the pretend work tree (not git-ignored). */
export const inMockRepo = (path: string): boolean => path.startsWith(`${MOCK_REPO}\\`);

export function mockSaveDialog(defaultName: string): Promise<string | null> {
  const answer = next;
  next = "save";
  const dir = answer === "repo" ? `${MOCK_REPO}\\` : WORK;
  return new Promise((r) => setTimeout(() => r(answer === "cancel" ? null : `${dir}${defaultName}`), 150));
}
