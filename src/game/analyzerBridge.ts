// Thin module-level bridge between GamePage and AnalyzerPage.
// GamePage writes initialState before navigating to analyzer;
// AnalyzerPage reads it on mount and writes pendingPlacement when the
// user selects a line; GamePage reads pendingPlacement on return.

import type { InfoState } from '../engine/index'
import type { Placement } from '../engine/placement'

export const analyzerBridge: {
  initialState: InfoState | null
  pendingPlacement: Placement | null
} = {
  initialState: null,
  pendingPlacement: null,
}
