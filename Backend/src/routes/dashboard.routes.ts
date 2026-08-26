import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error-handler.js';
import { getDailyApplications, getDashboardMetrics, getMonthlyApplications } from '../services/dashboard.service.js';

/** The dashboard's three read-only widgets: header cards, monthly chart, calendar counts. */
export function dashboardRoutes(requireAdmin: RequestHandler): Router {
  const router = Router();

  router.get(
    '/metrics',
    requireAdmin,
    asyncHandler(async (_req, res) => {
      res.json(await getDashboardMetrics());
    }),
  );

  router.get(
    '/monthly-applications',
    requireAdmin,
    asyncHandler(async (_req, res) => {
      res.json({ items: await getMonthlyApplications() });
    }),
  );

  const DailyQuerySchema = z.object({
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM')
      .optional(),
  });

  router.get(
    '/applications-by-day',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { month } = DailyQuerySchema.parse(req.query);
      res.json({ counts: await getDailyApplications(month) });
    }),
  );

  return router;
}
