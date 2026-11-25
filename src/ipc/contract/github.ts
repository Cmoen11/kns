// GitHub, read only (docs/catalog.md): the image tag each environment of an app runs, read from
// an ops (GitOps) repository, and the commits between two refs of an app repository. Rust asks
// the GitHub CLI (`gh api`); kns never holds a token. Only repositories of the loaded catalog.
// Mirror: src-tauri/src/contract/github.rs (types), src-tauri/src/github.rs (commands).

export interface GithubStatus {
  /** gh was found */
  installed: boolean;
  /** gh has a usable login for github.com */
  loggedIn: boolean;
  login?: string;
  /** why not, when it is not usable */
  message?: string;
}

/** The image one environment of one app runs, read from an ops repository. */
export interface EnvImage {
  app: string;
  env: string;
  /** the file in the repository */
  path: string;
  /** image.name */
  name?: string;
  /** image.tag */
  tag?: string;
  /** why the file gave no tag */
  error?: string;
}

export interface EnvImages {
  repo: string;
  /** the commit the files were read at */
  sha: string;
  /** by app, then environment */
  images: EnvImage[];
  /** GitHub cut the file list short, or there were more files than kns reads */
  truncated: boolean;
}

export interface GithubCommit {
  sha: string;
  /** first line of the message */
  title: string;
  /** GitHub login, else the git author name */
  author: string;
  /** RFC 3339 */
  date: string;
  /** the pull request it came from: `(#123)` or `Merge pull request #123` */
  pr?: number;
}

export interface GithubCompare {
  repo: string;
  /** the refs that resolved (`x` or `vx`) */
  base: string;
  head: string;
  /** ahead, behind, identical or diverged */
  status: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  /** newest first; GitHub returns at most 250 */
  commits: GithubCommit[];
  /** the compare page on github.com (catalogOpen opens it) */
  url: string;
}

export interface GithubBackend {
  /** Whether the GitHub CLI is installed and logged in, and as whom. Never rejects. */
  githubStatus(): Promise<GithubStatus>;
  /**
   * The image tag of every app in every environment of an ops repository of the catalog: the
   * files matching `imageFile` (`{app}/eks-{env}/image.yaml`) at the head of its default branch.
   */
  githubEnvImages(repo: string, imageFile: string): Promise<EnvImages>;
  /** The commits between two refs of a repository of the catalog; `x` and `vx` are both tried. */
  githubCompare(repo: string, base: string, head: string): Promise<GithubCompare>;
}
