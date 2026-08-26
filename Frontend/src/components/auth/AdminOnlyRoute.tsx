import { Navigate, Outlet } from "react-router";
import { useAuth } from "../../context/AuthContext";

export default function AdminOnlyRoute() {
  const { user } = useAuth();

  if (user?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
