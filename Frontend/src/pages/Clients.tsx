import { useState } from "react";
import PageBreadcrumb from "../components/common/PageBreadCrumb";
import ComponentCard from "../components/common/ComponentCard";
import PageMeta from "../components/common/PageMeta";
import ClientsTable from "../components/tables/ClientsTable";
import { Modal } from "../components/ui/modal";
import { useModal } from "../hooks/useModal";
import Button from "../components/ui/button/Button";
import Label from "../components/form/Label";
import Input from "../components/form/input/InputField";
import { useClients } from "../context/ClientsContext";

export default function Clients() {
  const { clients, addClient, total, page, limit, fetchClients } =
    useClients();
  const [name, setName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { isOpen, openModal, closeModal } = useModal();

  const totalPages = Math.max(1, Math.ceil(total / limit));

  const resetForm = () => {
    setName("");
    setContactEmail("");
    setPhone("");
    setError("");
  };

  const handleAddClient = async () => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }

    setIsSubmitting(true);
    setError("");
    const result = await addClient({
      name: name.trim(),
      contact_email: contactEmail.trim() || undefined,
      phone: phone.trim() || undefined,
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
        title="Clients | AAV - React.js Admin Dashboard Template"
        description="This is the Clients page"
      />
      <PageBreadcrumb pageTitle="Clients" />
      <div className="space-y-6">
        <div className="flex justify-end">
          <Button onClick={openModal}>Add Client</Button>
        </div>

        <ComponentCard title="Clients">
          <ClientsTable clients={clients} />
          <div className="flex items-center justify-between mt-4">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => fetchClients(page - 1)}
              >
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => fetchClients(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
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
            Add Client
          </h5>
          <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
            Add a new client to track applications against.
          </p>

          <div className="space-y-5">
            <div>
              <Label htmlFor="client-name">Name</Label>
              <Input
                id="client-name"
                type="text"
                placeholder="Acme Corp"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div>
              <Label htmlFor="client-email">Contact Email</Label>
              <Input
                id="client-email"
                type="email"
                placeholder="contact@acmecorp.com"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
              />
            </div>

            <div>
              <Label htmlFor="client-phone">Phone</Label>
              <Input
                id="client-phone"
                type="text"
                placeholder="+1 555-0101"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>

            {error && (
              <p className="text-sm text-error-500">{error}</p>
            )}
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
            <Button onClick={handleAddClient} disabled={isSubmitting}>
              {isSubmitting ? "Adding..." : "Add Client"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
