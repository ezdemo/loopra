export type VersionCheck = {
  currentVersion: string;
  latestVersion: string;
  hasNewVersion: boolean;
  releaseUrl?: string | null;
  releaseNotes?: string | null;
  checkTime?: string | null;
};
