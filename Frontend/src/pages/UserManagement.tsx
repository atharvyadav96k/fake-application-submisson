import { useEffect, useState, useCallback } from "react";
import PageBreadcrumb from "../components/common/PageBreadCrumb";
import ComponentCard from "../components/common/ComponentCard";
import PageMeta from "../components/common/PageMeta";
import UsersTable, { UserRow } from "../components/tables/UsersTable";
import Button from "../components/ui/button/Button";
import Label from "../components/form/Label";
import Input from "../components/form/input/InputField";
import Select from "../components/form/Select";
import api, { getApiErrorMessage } from "../lib/api";

type Role = "admin" | "manager" | "user";

interface WhitelistEntry {
  email: string;
  role: Role;
  created_at: string;
}

const roleOptions = [
  { value: "user", label: "User" },
  { value: "manager", label: "Manager" },
  { value: "admin", label: "Admin" },
];

export default function UserManagement() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [usersError, setUsersError] = useState("");
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);

  const [whitelist, setWhitelist] = useState<WhitelistEntry[]>([]);
  const [whitelistError, setWhitelistError] = useState("");
  const [isLoadingWhitelist, setIsLoadingWhitelist] = useState(false);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [isSubmittingWhitelist, setIsSubmittingWhitelist] = useState(false);
  const [formError, setFormError] = useState("");

  const loadUsers = useCallback(async () => {
    setIsLoadingUsers(true);
    setUsersError("");
    try {
      const response = await api.get<{ items: UserRow[] }>("/v1/users");
      setUsers(response.data.items);
    } catch (err) {
      setUsersError(getApiErrorMessage(err, "Unable to load users."));
    } finally {
      setIsLoadingUsers(false);
    }
  }, []);

  const loadWhitelist = useCallback(async () => {
    setIsLoadingWhitelist(true);
    setWhitelistError("");
    try {
      const response = await api.get<{ items: WhitelistEntry[] }>(
        "/v1/users/whitelist"
      );
      setWhitelist(response.data.items);
    } catch (err) {
      setWhitelistError(getApiErrorMessage(err, "Unable to load whitelist."));
    } finally {
      setIsLoadingWhitelist(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
    loadWhitelist();
  }, [loadUsers, loadWhitelist]);

  const handleToggleStatus = async (id: string, isActive: boolean) => {
    const previous = users;
    setUsers((prev) =>
      prev.map((user) => (user.id === id ? { ...user, active: isActive } : user))
    );
    try {
      await api.patch(`/v1/users/${id}/status`, { active: isActive });
    } catch (err) {
      setUsers(previous);
      setUsersError(getApiErrorMessage(err, "Unable to update user status."));
    }
  };

  const handleAddWhitelist = async () => {
    if (!email.trim()) {
      setFormError("Email is required.");
      return;
    }
    setFormError("");
    setIsSubmittingWhitelist(true);
    try {
      await api.post("/v1/users/whitelist", { email: email.trim(), role });
      setEmail("");
      setRole("user");
      await loadWhitelist();
    } catch (err) {
      setFormError(getApiErrorMessage(err, "Unable to whitelist email."));
    } finally {
      setIsSubmittingWhitelist(false);
    }
  };

  const handleRemoveWhitelist = async (whitelistedEmail: string) => {
    if (!window.confirm(`Remove ${whitelistedEmail} from the whitelist?`)) {
      return;
    }
    try {
      await api.delete(`/v1/users/whitelist/${encodeURIComponent(whitelistedEmail)}`);
      setWhitelist((prev) =>
        prev.filter((entry) => entry.email !== whitelistedEmail)
      );
    } catch (err) {
      setWhitelistError(getApiErrorMessage(err, "Unable to remove from whitelist."));
    }
  };

  return (
    <>
      <PageMeta
        title="User Management | AAV - React.js Admin Dashboard Template"
        description="This is the User Management page"
      />
      <PageBreadcrumb pageTitle="User Management" />
      <div className="space-y-6">
        <ComponentCard title="Users">
          {usersError && (
            <p className="mb-3 text-sm text-error-500">{usersError}</p>
          )}
          {isLoadingUsers ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading users...</p>
          ) : (
            <UsersTable users={users} onToggleStatus={handleToggleStatus} />
          )}
        </ComponentCard>

        <ComponentCard title="Whitelist Email">
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            Whitelist an email so it can be used to sign up. Users create their
            own account via Sign Up once whitelisted.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:items-end">
            <div className="sm:col-span-1">
              <Label htmlFor="whitelist-email">Email</Label>
              <Input
                id="whitelist-email"
                type="email"
                placeholder="john.doe@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="sm:col-span-1">
              <Label htmlFor="whitelist-role">Role</Label>
              <Select
                options={roleOptions}
                defaultValue={role}
                onChange={(value) => setRole(value as Role)}
              />
            </div>
            <div className="sm:col-span-1">
              <Button onClick={handleAddWhitelist} disabled={isSubmittingWhitelist}>
                {isSubmittingWhitelist ? "Adding..." : "Add to Whitelist"}
              </Button>
            </div>
          </div>
          {formError && (
            <p className="mt-2 text-sm text-error-500">{formError}</p>
          )}

          <div className="mt-6">
            <h4 className="mb-3 text-sm font-semibold text-gray-800 dark:text-white/90">
              Whitelisted (not yet registered)
            </h4>
            {whitelistError && (
              <p className="mb-3 text-sm text-error-500">{whitelistError}</p>
            )}
            {isLoadingWhitelist ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">Loading...</p>
            ) : whitelist.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No pending whitelisted emails.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-white/[0.05]">
                {whitelist.map((entry) => (
                  <li
                    key={entry.email}
                    className="flex items-center justify-between py-3"
                  >
                    <div>
                      <span className="block text-sm font-medium text-gray-800 dark:text-white/90">
                        {entry.email}
                      </span>
                      <span className="block text-xs text-gray-500 dark:text-gray-400 capitalize">
                        {entry.role}
                      </span>
                    </div>
                    <button
                      onClick={() => handleRemoveWhitelist(entry.email)}
                      className="text-sm font-medium text-error-500 hover:text-error-600"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </ComponentCard>
      </div>
    </>
  );
}
