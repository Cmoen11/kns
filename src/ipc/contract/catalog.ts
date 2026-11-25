// The organisation catalog (docs/catalog.md): teams, the systems they own, the namespace and
// repositories of each, and which kube context is which environment. Rust reads the file
// (catalog.rs; the window never sends a path); this is its normalised form. Optional: every
// field may be empty, and kns works without a catalog.
// Mirror: src-tauri/src/catalog.rs.

export interface CatalogLink {
  url: string;
  title: string;
}

export interface CatalogTeam {
  name: string;
  title: string;
  links: CatalogLink[];
  /** user entity names */
  members: string[];
}

export interface CatalogUser {
  name: string;
  email?: string;
  /** team names */
  memberOf: string[];
}

export interface CatalogGitops {
  /** argocd, flux, ... */
  tool: string;
  path?: string;
  /** where an environment's image tag is, with {app} and {env} */
  imageFile?: string;
  /** a workload is <appPrefix><app> */
  appPrefix?: string;
}

export interface CatalogComponent {
  name: string;
  description: string;
  /** spec.type: service, website, library, gitops ... */
  type: string;
  /** owner/repo on GitHub */
  repo?: string;
  /** workload names it deploys */
  workloads: string[];
  gitops?: CatalogGitops;
  links: CatalogLink[];
}

export interface CatalogSystem {
  name: string;
  title: string;
  description: string;
  /** owning team name */
  owner?: string;
  /** its namespace in every environment; absent = none */
  namespace?: string;
  /** environments it runs in; empty = every one */
  environments: string[];
  /** Secrets its namespace should have */
  expectedSecrets: string[];
  components: CatalogComponent[];
  links: CatalogLink[];
}

export interface CatalogCluster {
  name: string;
  title: string;
  environment?: string;
  /** a context whose name or cluster contains one of these is this cluster */
  contextMatch: string[];
  protected: boolean;
  /** label keys its workloads carry */
  labels: { team?: string; system?: string; service?: string; version?: string };
}

export interface Catalog {
  /** the file, as shown */
  source: string;
  teams: CatalogTeam[];
  users: CatalogUser[];
  systems: CatalogSystem[];
  clusters: CatalogCluster[];
  /** what was skipped and why */
  warnings: string[];
}

export interface CatalogBackend {
  /** The chosen catalog, read again from its file; null when none was chosen. */
  catalogLoad(): Promise<Catalog | null>;
  /** Opens a file dialog (in Rust); a file that reads as a catalog is remembered. null = cancelled. */
  catalogChoose(): Promise<Catalog | null>;
  /** Forgets the chosen file (the file is left alone). */
  catalogForget(): Promise<void>;
  /** Opens a link of the loaded catalog in the browser; Rust refuses any other URL. */
  catalogOpen(url: string): Promise<void>;
}
