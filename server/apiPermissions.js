import { requireAdmin } from './authMiddleware.js';

// Shared by Express production, Vite development and Vite preview.
// The factor list stays available to the recommendation dropdown; research
// returns, research details and all administration endpoints require admin.
export function registerApiPermissions(middlewares) {
  for (const path of ['/api/admin', '/api/factor-returns', '/api/factor-detail']) {
    middlewares.use(path, requireAdmin);
  }
}
