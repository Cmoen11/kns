// Tauri mapping of GithubBackend (contract/github.ts, github.rs).
import type { GithubBackend } from "../types";
import { call } from "./call";

export const githubTauri: GithubBackend = {
  githubStatus: () => call("github_status"),
  githubEnvImages: (repo, imageFile) => call("github_env_images", { repo, imageFile }),
  githubCompare: (repo, base, head) => call("github_compare", { repo, base, head }),
};
