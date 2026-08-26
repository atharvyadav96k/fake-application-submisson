import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import api, { getApiErrorMessage } from "../lib/api";
import { useAuth } from "./AuthContext";

export interface ApplicationRow {
  id: string;
  clientId: string | null;
  clientName: string | null;
  portal: string;
  status: "Applied" | "Not Applied";
  businessDate: string;
  trustScore: number;
  manualEntry: boolean;
  verified: boolean;
  ownerId: string;
}

interface ApplicationsListResponse {
  items: ApplicationRow[];
  total: number;
  page: number;
  limit: number;
}

export interface AddApplicationInput {
  client_id: string;
  portal: string;
  status: "Applied" | "Not Applied";
  business_date?: string;
  notes?: string;
}

export type MutationResult =
  | { success: true }
  | { success: false; error: string };

interface ApplicationsContextValue {
  applications: ApplicationRow[];
  total: number;
  page: number;
  limit: number;
  isLoading: boolean;
  error: string | null;
  refresh: (page?: number) => Promise<void>;
  addApplication: (input: AddApplicationInput) => Promise<MutationResult>;
  verifyApplication: (id: string, trustScore: number) => Promise<MutationResult>;
}

const ApplicationsContext = createContext<ApplicationsContextValue | null>(
  null
);

export function ApplicationsProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (targetPage: number = page) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await api.get<ApplicationsListResponse>(
          "/v1/applications",
          { params: { page: targetPage, limit } }
        );
        setApplications(response.data.items);
        setTotal(response.data.total);
        setPage(response.data.page);
      } catch (err) {
        setError(getApiErrorMessage(err, "Unable to load applications."));
      } finally {
        setIsLoading(false);
      }
    },
    [page, limit]
  );

  useEffect(() => {
    if (isAuthenticated) {
      refresh(1);
    } else {
      setApplications([]);
      setTotal(0);
      setPage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  const addApplication = useCallback(
    async (input: AddApplicationInput): Promise<MutationResult> => {
      try {
        await api.post("/v1/applications/manual", input);
        await refresh(1);
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: getApiErrorMessage(err, "Unable to log application."),
        };
      }
    },
    [refresh]
  );

  const verifyApplication = useCallback(
    async (id: string, trustScore: number): Promise<MutationResult> => {
      try {
        const response = await api.post<ApplicationRow>(
          `/v1/applications/${id}/verify`,
          { trust_score: trustScore }
        );
        setApplications((prev) =>
          prev.map((application) =>
            application.id === id ? response.data : application
          )
        );
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: getApiErrorMessage(err, "Unable to verify application."),
        };
      }
    },
    []
  );

  return (
    <ApplicationsContext.Provider
      value={{
        applications,
        total,
        page,
        limit,
        isLoading,
        error,
        refresh,
        addApplication,
        verifyApplication,
      }}
    >
      {children}
    </ApplicationsContext.Provider>
  );
}

export function useApplications() {
  const context = useContext(ApplicationsContext);
  if (!context) {
    throw new Error(
      "useApplications must be used within an ApplicationsProvider"
    );
  }
  return context;
}
