// Moved to @systemsage/engine (see its src/layout.ts) once applyStep needed
// it too, and applyStep needs to live in the engine package since it has no
// Gemini dependency. Re-exported here so existing imports of
// `assignLayout` from @systemsage/lesson-planner keep working unchanged.
export { assignLayout } from '@systemsage/engine';
