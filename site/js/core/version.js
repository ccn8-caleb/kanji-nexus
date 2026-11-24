// App version, shown in the Data panel and the ⋯ sheet.
//
// APP_VERSION: bump this (semver) when releasing, and add a matching
//   "## [x.y.z]" entry to CHANGELOG.md — CI fails without one.
// BUILD / BUILD_DATE: stamped by tools/stamp-deploy.sh at deploy time
//   (commit hash and UTC date). They stay 'dev' / '' when running locally.

export const APP_VERSION = '0.5.0';
export const BUILD = 'dev';
export const BUILD_DATE = '';

export const CHANGELOG_URL = 'https://github.com/ccn8-caleb/kanji-nexus/blob/master/CHANGELOG.md';

// "v0.5.0 · build e9a6960 · 2026-11-24" (or "v0.5.0 · dev build")
export function versionLabel() {
  if (BUILD === 'dev') return `v${APP_VERSION} · dev build`;
  return `v${APP_VERSION} · build ${BUILD.slice(0, 7)}${BUILD_DATE ? ` · ${BUILD_DATE}` : ''}`;
}
