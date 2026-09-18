import { ipcMain } from 'electron'
import { detectBoundaries } from '../services/boundaryDetection'
import { loadBoundaryEndpoint } from '../services/boundaryEndpointPrefs'
import type { BoundaryDetectPayload, BoundaryDetectResult } from '../../src/types/ipc'

// Watch AI boundary detection (Phase 14B) — thin handler over
// boundaryDetection.ts, matching every other subprocess/service handler
// file's shape in this app (all logic lives in services/, this just wires
// IPC to it). Resolves the operator's endpoint override (if any) on every
// call rather than caching it, since it's a rarely-set, cheap file read and
// the deployment is still expected to move.
export function registerBoundaryHandlers(): void {
  ipcMain.handle('boundary:detect', async (_event, payload: BoundaryDetectPayload): Promise<BoundaryDetectResult> => {
    const endpointOverride = await loadBoundaryEndpoint()
    return detectBoundaries(payload.imagePath, payload.measureBy, endpointOverride)
  })
}
