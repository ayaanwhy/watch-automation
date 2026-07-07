// Renderer-side path helpers — there is no Node.js path module in the
// renderer. Scoped to the new Preprocessing execution/details UI (Phase 9D);
// AnnotationWorkspace.tsx keeps its own local copy rather than importing this
// to avoid touching Watch Processing files in this milestone.

export function joinPath(dir: string, file: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + file
  return dir.includes('\\') ? `${dir}\\${file}` : `${dir}/${file}`
}

export function toFileUrl(path: string): string {
  return `file://${path.replace(/\\/g, '/')}`
}
