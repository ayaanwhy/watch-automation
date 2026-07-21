// Top-level views reachable from the persistent sidebar, plus 'batchDetails'
// (Phase 9E) — reached only by opening a batch from Home, not from the
// sidebar itself, so it deliberately has no sidebar nav item of its own.
//
// 'editing' (Phase 10D) replaces the old dedicated 'watch' view — Watch, Ring,
// and Bracelet now all enter through the same shared Editing setup screen,
// distinguished by an `editingProduct` piece of state (see App.tsx) rather
// than by separate views. This is a navigation-shell change only; Watch's
// own annotation/validation/session behavior is unaffected.
//
// 'preprocessingWorkspace' (Phase 10F correction) — the dedicated live-run
// screen, separate from 'preprocessing' (the listing/launcher: Configure +
// recent batches). 'preprocessing' never shows a running job inline anymore;
// opening or starting one navigates to this view instead, whose own Back
// returns to 'preprocessing', not 'home'.
export type AppView = 'home' | 'preprocessing' | 'preprocessingWorkspace' | 'editing' | 'settings' | 'batchDetails'

// Which product the shared Editing setup screen is currently configuring.
// Sidebar shortcuts (Watches/Rings/Bracelets) each preselect one; Home's
// generic "Editing" entry leaves it at the screen's own default.
export type EditingProduct = 'watch' | 'ring' | 'bracelet'
