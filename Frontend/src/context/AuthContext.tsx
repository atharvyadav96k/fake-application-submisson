import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  ReactNode,
} from "react";
import api, {
  TOKEN_STORAGE_KEY,
  USER_STORAGE_KEY,
  getApiErrorMessage,
} from "../lib/api";

export type UserRole = "admin" | "manager" | "user";

export interface AuthUser {
  id?: string;
  email: string;
  name: string;
  role: UserRole;
}

interface AuthResponse {
  token: string;
  role: UserRole;
  email: string;
  name: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(TOKEN_STORAGE_KEY)
  );
  const [user, setUser] = useState<AuthUser | null>(() => readStoredUser());

  const persistSession = useCallback((data: AuthResponse) => {
    const authUser: AuthUser = {
      email: data.email,
      name: data.name,
      role: data.role,
    };
    localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(authUser));
    setToken(data.token);
    setUser(authUser);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      try {
        const response = await api.post<AuthResponse>("/v1/auth/login", {
          email,
          password,
        });
        persistSession(response.data);
      } catch (error) {
        throw new Error(getApiErrorMessage(error, "Unable to sign in. Please check your credentials."));
      }
    },
    [persistSession]
  );

  const signup = useCallback(
    async (email: string, password: string, name: string) => {
      try {
        const response = await api.post<AuthResponse>("/v1/auth/signup", {
          email,
          password,
          name,
        });
        persistSession(response.data);
      } catch (error) {
        throw new Error(getApiErrorMessage(error, "Unable to sign up. Please try again."));
      }
    },
    [persistSession]
  );

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isAuthenticated: Boolean(token),
      login,
      signup,
      logout,
    }),
    [user, token, login, signup, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
