import { ClientModel } from '../db/models/client.model.js';
import { SessionModel } from '../db/models/session.model.js';
import { UserModel } from '../db/models/user.model.js';
import { round } from '../utils/time.js';

/** Cards on the dashboard header: current totals plus growth since the start of this month. */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function changePct(current: number, before: number): number {
  if (before === 0) return current > 0 ? 100 : 0;
  return round(((current - before) / before) * 100, 2);
}

export interface DashboardMetrics {
  users: { total: number; change_pct: number };
  clients: { total: number; change_pct: number };
  applications: { total: number; change_pct: number };
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const monthStart = startOfMonth(new Date());

  const [totalUsers, usersBeforeMonth, totalClients, clientsBeforeMonth, totalApplications, applicationsBeforeMonth] =
    await Promise.all([
      UserModel.countDocuments({}),
      UserModel.countDocuments({ created_at: { $lt: monthStart } }),
      ClientModel.countDocuments({}),
      ClientModel.countDocuments({ created_at: { $lt: monthStart } }),
      SessionModel.countDocuments({}),
      SessionModel.countDocuments({ first_seen_at: { $lt: monthStart } }),
    ]);

  return {
    users: { total: totalUsers, change_pct: changePct(totalUsers, usersBeforeMonth) },
    clients: { total: totalClients, change_pct: changePct(totalClients, clientsBeforeMonth) },
    applications: { total: totalApplications, change_pct: changePct(totalApplications, applicationsBeforeMonth) },
  };
}

export interface MonthlyApplicationCount {
  month: string;
  year: number;
  count: number;
}

/** Application counts for the trailing 12 months (including the current one), oldest first. */
export async function getMonthlyApplications(): Promise<MonthlyApplicationCount[]> {
  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);

  const rows = await SessionModel.aggregate([
    { $match: { first_seen_at: { $gte: rangeStart } } },
    {
      $group: {
        _id: { year: { $year: '$first_seen_at' }, month: { $month: '$first_seen_at' } },
        count: { $sum: 1 },
      },
    },
  ]);

  const countByKey = new Map<string, number>(rows.map((r) => [`${r._id.year}-${r._id.month}`, r.count]));

  const result: MonthlyApplicationCount[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
    result.push({ month: MONTH_NAMES[d.getMonth()] as string, year: d.getFullYear(), count: countByKey.get(key) ?? 0 });
  }
  return result;
}

/** Per-day application counts for one calendar month (defaults to the current month). `month` is "YYYY-MM". */
export async function getDailyApplications(month?: string): Promise<Record<string, number>> {
  const now = new Date();
  let year = now.getFullYear();
  let monthIndex = now.getMonth();

  if (month) {
    const [y, m] = month.split('-').map(Number);
    if (y !== undefined) year = y;
    if (m !== undefined) monthIndex = m - 1;
  }

  const rangeStart = new Date(year, monthIndex, 1);
  const rangeEnd = new Date(year, monthIndex + 1, 1);

  const rows = await SessionModel.aggregate([
    { $match: { first_seen_at: { $gte: rangeStart, $lt: rangeEnd } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$first_seen_at' } },
        count: { $sum: 1 },
      },
    },
  ]);

  return Object.fromEntries(rows.map((r) => [r._id as string, r.count as number]));
}
