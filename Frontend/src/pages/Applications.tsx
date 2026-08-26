import { useState } from "react";
import PageBreadcrumb from "../components/common/PageBreadCrumb";
import ComponentCard from "../components/common/ComponentCard";
import PageMeta from "../components/common/PageMeta";
import ApplicationsTable from "../components/tables/ApplicationsTable";
import { Modal } from "../components/ui/modal";
import { useModal } from "../hooks/useModal";
import Button from "../components/ui/button/Button";
import Label from "../components/form/Label";
import Input from "../components/form/input/InputField";
import Select from "../components/form/Select";
import { useApplications } from "../context/ApplicationsContext";
import { useClients } from "../context/ClientsContext";

const statusOptions = [
  { value: "Applied", label: "Applied" },
  { value: "Not Applied", label: "Not Applied" },
];

export default function Applications() {
  const { applications, addApplication } = useApplications();
  const { clients } = useClients();
  const clientOptions = clients.map((client) => ({
    value: client.id,
    label: client.name,
  }));
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [portal, setPortal] = useState("");
  const [status, setStatus] = useState<"Applied" | "Not Applied">("Applied");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { isOpen, openModal, closeModal } = useModal();

  const resetForm = () => {
    setClientId(clients[0]?.id ?? "");
    setPortal("");
    setStatus("Applied");
    setNotes("");
    setError("");
  };

  const handleAddApplication = async () => {
    if (!clientId || !portal.trim()) {
      setError("Client and portal are required.");
      return;
    }

    setIsSubmitting(true);
    setError("");
    const result = await addApplication({
      client_id: clientId,
      portal: portal.trim(),
      status,
      notes: notes.trim() || undefined,
    });
    setIsSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }

    closeModal();
    resetForm();
  };

  return (
    <>
      <PageMeta
        title="Applications | AAV - React.js Admin Dashboard Template"
        description="This is the Applications page"
      />
      <PageBreadcrumb pageTitle="Applications" />
      <div className="space-y-6">
        <div className="flex justify-end">
          <Button onClick={openModal}>Log Application</Button>
        </div>

        <ComponentCard title="Applications">
          <ApplicationsTable applications={applications} />
        </ComponentCard>
      </div>

      <Modal
        isOpen={isOpen}
        onClose={() => {
          closeModal();
          resetForm();
        }}
        className="max-w-[500px] p-6 lg:p-10"
      >
        <div className="flex max-h-[80vh] flex-col overflow-y-auto px-2 custom-scrollbar">
          <h5 className="mb-2 font-semibold text-gray-800 text-theme-xl dark:text-white/90 lg:text-2xl">
            Log Application
          </h5>
          <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
            Manually record a job application.
          </p>

          <div className="space-y-5">
            <div>
              <Label htmlFor="application-client">Client</Label>
              <Select
                options={clientOptions}
                defaultValue={clientId}
                onChange={(value) => setClientId(value)}
              />
            </div>

            <div>
              <Label htmlFor="application-portal">Portal</Label>
              <Input
                id="application-portal"
                type="text"
                placeholder="LinkedIn, Indeed, Naukri..."
                value={portal}
                onChange={(e) => setPortal(e.target.value)}
              />
            </div>

            <div>
              <Label htmlFor="application-status">Status</Label>
              <Select
                options={statusOptions}
                defaultValue={status}
                onChange={(value) =>
                  setStatus(value as "Applied" | "Not Applied")
                }
              />
            </div>

            <div>
              <Label htmlFor="application-notes">Notes (optional)</Label>
              <Input
                id="application-notes"
                type="text"
                placeholder="Any additional context..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {error && <p className="text-sm text-error-500">{error}</p>}
          </div>

          <div className="flex items-center gap-3 mt-8 sm:justify-end">
            <Button
              variant="outline"
              onClick={() => {
                closeModal();
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleAddApplication} disabled={isSubmitting}>
              {isSubmitting ? "Logging..." : "Log Application"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
