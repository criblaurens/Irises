// Shim: the dashboard grew into a directory (router + api modules + per-view
// templates). Kept at the old path so src/index.ts's import stays untouched
// (NodeNext resolution has no directory imports).
export { createAdminDashboardRouter } from './adminDashboard/router.js';
export { passwordConfigured } from './adminDashboard/auth.js';
