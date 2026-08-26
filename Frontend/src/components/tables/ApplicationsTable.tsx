import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "../ui/table";

import Badge from "../ui/badge/Badge";
import Button from "../ui/button/Button";
import { useAuth } from "../../context/AuthContext";
import {
  ApplicationRow,
  useApplications,
} from "../../context/ApplicationsContext";

export type { ApplicationRow };

interface ApplicationsTableProps {
  applications: ApplicationRow[];
  showClientColumn?: boolean;
}

const statusColor: Record<ApplicationRow["status"], "success" | "light"> = {
  Applied: "success",
  "Not Applied": "light",
};

const trustScoreColor = (score: number) => {
  if (score >= 70) return "success";
  if (score >= 40) return "warning";
  return "error";
};

function VerifyControl({ application }: { application: ApplicationRow }) {
  const { verifyApplication } = useApplications();
  const [isOpen, setIsOpen] = useState(false);
  const [score, setScore] = useState("0");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleConfirm = async () => {
    const parsed = Number(score);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
      setError("Enter a score between 0 and 100.");
      return;
    }
    setIsSubmitting(true);
    setError("");
    const result = await verifyApplication(application.id, parsed);
    setIsSubmitting(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setIsOpen(false);
  };

  if (!isOpen) {
    return (
      <Button size="sm" variant="outline" onClick={() => setIsOpen(true)}>
        Verify
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          max={100}
          value={score}
          onChange={(e) => setScore(e.target.value)}
          className="h-8 w-20 rounded-md border border-gray-300 bg-transparent px-2 text-sm dark:border-gray-700 dark:text-white/90"
        />
        <Button size="sm" onClick={handleConfirm} disabled={isSubmitting}>
          {isSubmitting ? "Saving..." : "Confirm"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setIsOpen(false)}>
          Cancel
        </Button>
      </div>
      {error && <span className="text-xs text-error-500">{error}</span>}
    </div>
  );
}

export default function ApplicationsTable({
  applications,
  showClientColumn = true,
}: ApplicationsTableProps) {
  const { user } = useAuth();
  const canVerify = user?.role === "admin" || user?.role === "manager";

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-white/[0.05] dark:bg-white/[0.03]">
      <div className="max-w-full overflow-x-auto">
        <div className="min-w-[1100px]">
          <Table>
            <TableHeader className="border-b border-gray-100 dark:border-white/[0.05]">
              <TableRow>
                {showClientColumn && (
                  <TableCell
                    isHeader
                    className="px-5 py-3 font-medium text-gray-500 text-start text-theme-xs dark:text-gray-400"
                  >
                    Client
                  </TableCell>
                )}
                <TableCell
                  isHeader
                  className="px-5 py-3 font-medium text-gray-500 text-start text-theme-xs dark:text-gray-400"
                >
                  Portal
                </TableCell>
                <TableCell
                  isHeader
                  className="px-5 py-3 font-medium text-gray-500 text-start text-theme-xs dark:text-gray-400"
                >
                  Status
                </TableCell>
                <TableCell
                  isHeader
                  className="px-5 py-3 font-medium text-gray-500 text-start text-theme-xs dark:text-gray-400"
                >
                  Business Date
                </TableCell>
                <TableCell
                  isHeader
                  className="px-5 py-3 font-medium text-gray-500 text-start text-theme-xs dark:text-gray-400"
                >
                  Trust Score
                </TableCell>
                {canVerify && (
                  <TableCell
                    isHeader
                    className="px-5 py-3 font-medium text-gray-500 text-start text-theme-xs dark:text-gray-400"
                  >
                    Actions
                  </TableCell>
                )}
              </TableRow>
            </TableHeader>

            <TableBody className="divide-y divide-gray-100 dark:divide-white/[0.05]">
              {applications.map((application) => (
                <TableRow key={application.id}>
                  {showClientColumn && (
                    <TableCell className="px-5 py-4 sm:px-6 text-start">
                      <span className="block font-medium text-gray-800 text-theme-sm dark:text-white/90">
                        {application.clientName ?? "Unknown"}
                      </span>
                    </TableCell>
                  )}
                  <TableCell className="px-4 py-3 text-gray-500 text-start text-theme-sm dark:text-gray-400">
                    {application.portal}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-gray-500 text-start text-theme-sm dark:text-gray-400">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge size="sm" color={statusColor[application.status]}>
                        {application.status}
                      </Badge>
                      {application.manualEntry && !application.verified && (
                        <Badge size="sm" color="warning">
                          Pending verification
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-gray-500 text-start text-theme-sm dark:text-gray-400">
                    {application.businessDate}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-gray-500 text-start text-theme-sm dark:text-gray-400">
                    <Badge
                      size="sm"
                      color={trustScoreColor(application.trustScore)}
                    >
                      {application.trustScore}
                    </Badge>
                  </TableCell>
                  {canVerify && (
                    <TableCell className="px-4 py-3 text-gray-500 text-start text-theme-sm dark:text-gray-400">
                      {application.manualEntry && !application.verified ? (
                        <VerifyControl application={application} />
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
