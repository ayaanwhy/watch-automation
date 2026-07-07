// Launchable processing modules — each corresponds to a StageType and has its
// own persistent sidebar destination. Entering one is pure navigation into a
// workflow's configuration screen; no Batch exists until the workflow's
// execution action (Start / Begin Annotation) is triggered — see App.tsx.
export type LaunchableModule = 'preprocessing' | 'watch'

// Top-level views reachable from the persistent sidebar.
export type AppView = 'home' | 'preprocessing' | 'watch' | 'settings'
