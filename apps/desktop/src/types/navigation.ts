// Selectable application modules. Add a new module by extending this union,
// adding an entry to ModuleSelector's descriptor list, and one render branch
// in App.tsx — no navigation restructuring required.
export type LaunchableModule = 'preprocessing' | 'watch'

export type AppModule = 'selector' | LaunchableModule
