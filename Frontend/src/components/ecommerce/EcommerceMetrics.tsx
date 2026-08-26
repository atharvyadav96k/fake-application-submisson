import { useEffect, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GroupIcon,
  UserCircleIcon,
  DocsIcon,
} from "../../icons";
import Badge from "../ui/badge/Badge";
import api, { getApiErrorMessage } from "../../lib/api";

interface DashboardMetrics {
  users: { total: number; change_pct: number };
  clients: { total: number; change_pct: number };
  applications: { total: number; change_pct: number };
}

export default function EcommerceMetrics() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<DashboardMetrics>("/v1/dashboard/metrics")
      .then((res) => {
        if (!cancelled) setMetrics(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(getApiErrorMessage(err, "Unable to load metrics."));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cards = [
    { label: "Total Users", icon: GroupIcon, data: metrics?.users },
    { label: "Total Clients", icon: UserCircleIcon, data: metrics?.clients },
    { label: "Client Applications", icon: DocsIcon, data: metrics?.applications },
  ];

  if (error) {
    return <p className="text-sm text-error-500">{error}</p>;
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 md:gap-6">
      {cards.map(({ label, icon: Icon, data }) => {
        const isPositive = (data?.change_pct ?? 0) >= 0;
        return (
          <div
            key={label}
            className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/[0.03] md:p-6"
          >
            <div className="flex items-center justify-center w-12 h-12 bg-gray-100 rounded-xl dark:bg-gray-800">
              <Icon className="text-gray-800 size-6 dark:text-white/90" />
            </div>

            <div className="flex items-end justify-between mt-5">
              <div>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {label}
                </span>
                <h4 className="mt-2 font-bold text-gray-800 text-title-sm dark:text-white/90">
                  {data ? data.total.toLocaleString() : "—"}
                </h4>
              </div>
              {data && (
                <Badge color={isPositive ? "success" : "error"}>
                  {isPositive ? <ArrowUpIcon /> : <ArrowDownIcon />}
                  {Math.abs(data.change_pct)}%
                </Badge>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
