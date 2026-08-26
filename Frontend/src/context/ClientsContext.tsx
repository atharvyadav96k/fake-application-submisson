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

export interface ClientRow {
  id: string;
  name: string;
  domain: string | null;
  contact_email: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientInput {
  name: string;
  domain?: string;
  contact_email?: string;
  phone?: string;
  notes?: string;
}

interface ClientsListResponse {
  items: ClientRow[];
  total: number;
  page: number;
  limit: number;
}

export type ClientMutationResult =
  | { success: true; client?: ClientRow }
  | { success: false; error: string };

interface ClientsContextValue {
  clients: ClientRow[];
  total: number;
  page: number;
  limit: number;
  isLoading: boolean;
  error: string | null;
  fetchClients: (page?: number) => Promise<void>;
  addClient: (client: ClientInput) => Promise<ClientMutationResult>;
  updateClient: (id: string, client: ClientInput) => Promise<ClientMutationResult>;
  deleteClient: (id: string) => Promise<ClientMutationResult>;
}

const ClientsContext = createContext<ClientsContextValue | null>(null);

export function ClientsProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchClients = useCallback(
    async (targetPage: number = page) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await api.get<ClientsListResponse>("/v1/clients", {
          params: { page: targetPage, limit },
        });
        setClients(response.data.items);
        setTotal(response.data.total);
        setPage(response.data.page);
      } catch (err) {
        setError(getApiErrorMessage(err, "Unable to load clients."));
      } finally {
        setIsLoading(false);
      }
    },
    [page, limit]
  );

  useEffect(() => {
    if (isAuthenticated) {
      fetchClients(1);
    } else {
      setClients([]);
      setTotal(0);
      setPage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  const addClient = useCallback(
    async (client: ClientInput): Promise<ClientMutationResult> => {
      try {
        const response = await api.post<ClientRow>("/v1/clients", client);
        await fetchClients(1);
        return { success: true, client: response.data };
      } catch (err) {
        return {
          success: false,
          error: getApiErrorMessage(err, "Unable to add client."),
        };
      }
    },
    [fetchClients]
  );

  const updateClient = useCallback(
    async (id: string, client: ClientInput): Promise<ClientMutationResult> => {
      try {
        const response = await api.put<ClientRow>(`/v1/clients/${id}`, client);
        setClients((prev) =>
          prev.map((existing) => (existing.id === id ? response.data : existing))
        );
        return { success: true, client: response.data };
      } catch (err) {
        return {
          success: false,
          error: getApiErrorMessage(err, "Unable to update client."),
        };
      }
    },
    []
  );

  const deleteClient = useCallback(
    async (id: string): Promise<ClientMutationResult> => {
      try {
        await api.delete(`/v1/clients/${id}`);
        await fetchClients(page);
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: getApiErrorMessage(err, "Unable to delete client."),
        };
      }
    },
    [fetchClients, page]
  );

  return (
    <ClientsContext.Provider
      value={{
        clients,
        total,
        page,
        limit,
        isLoading,
        error,
        fetchClients,
        addClient,
        updateClient,
        deleteClient,
      }}
    >
      {children}
    </ClientsContext.Provider>
  );
}

export function useClients() {
  const context = useContext(ClientsContext);
  if (!context) {
    throw new Error("useClients must be used within a ClientsProvider");
  }
  return context;
}
