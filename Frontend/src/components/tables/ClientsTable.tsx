import { useState } from "react";
import { Link } from "react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "../ui/table";
import { ClientRow, useClients } from "../../context/ClientsContext";
import { Modal } from "../ui/modal";
import { useModal } from "../../hooks/useModal";
import Button from "../ui/button/Button";
import Label from "../form/Label";
import Input from "../form/input/InputField";

interface ClientsTableProps {
  clients: ClientRow[];
}

function EditClientModal({
  client,
  isOpen,
  onClose,
}: {
  client: ClientRow;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { updateClient } = useClients();
  const [name, setName] = useState(client.name);
  const [domain, setDomain] = useState(client.domain ?? "");
  const [contactEmail, setContactEmail] = useState(client.contact_email ?? "");
  const [phone, setPhone] = useState(client.phone ?? "");
  const [notes, setNotes] = useState(client.notes ?? "");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setIsSubmitting(true);
    setError("");
    const result = await updateClient(client.id, {
      name: name.trim(),
      domain: domain.trim() || undefined,
      contact_email: contactEmail.trim() || undefined,
      phone: phone.trim() || undefined,
      notes: notes.trim() || undefined,
    });
    setIsSubmitting(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} className="max-w-[500px] p-6 lg:p-10">
      <div className="flex max-h-[80vh] flex-col overflow-y-auto px-2 custom-scrollbar">
        <h5 className="mb-2 font-semibold text-gray-800 text-theme-xl dark:text-white/90 lg:text-2xl">
          Edit Client
        </h5>
        <div className="space-y-5">
          <div>
            <Label htmlFor="edit-client-name">Name</Label>
            <Input
              id="edit-client-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="edit-client-domain">Domain</Label>
            <Input
              id="edit-client-domain"
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="edit-client-email">Contact Email</Label>
            <Input
              id="edit-client-email"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="edit-client-phone">Phone</Label>
            <Input
              id="edit-client-phone"
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="edit-client-notes">Notes</Label>
            <Input
              id="edit-client-notes"
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-error-500">{error}</p>}
        </div>
        <div className="flex items-center gap-3 mt-8 sm:justify-end">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ClientRowActions({ client }: { client: ClientRow }) {
  const { deleteClient } = useClients();
  const { isOpen, openModal, closeModal } = useModal();
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    if (!window.confirm(`Delete client "${client.name}"? This cannot be undone.`)) {
      return;
    }
    setIsDeleting(true);
    const result = await deleteClient(client.id);
    setIsDeleting(false);
    if (!result.success) {
      window.alert(result.error);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={openModal}
        className="text-sm font-medium text-brand-500 hover:text-brand-600"
      >
        Edit
      </button>
      <button
        onClick={handleDelete}
        disabled={isDeleting}
        className="text-sm font-medium text-error-500 hover:text-error-600 disabled:opacity-50"
      >
        {isDeleting ? "Deleting..." : "Delete"}
      </button>
      <EditClientModal client={client} isOpen={isOpen} onClose={closeModal} />
    </div>
  );
}

export default function ClientsTable({ clients }: ClientsTableProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-white/[0.05] dark:bg-white/[0.03]">
      <div className="max-w-full overflow-x-auto">
        <div className="min-w-[800px]">
          <Table>
            <TableHeader className="border-b border-gray-100 dark:border-white/[0.05]">
              <TableRow>
                <TableCell
                  isHeader
                  className="px-5 py-3 font-medium text-gray-500 text-start text-theme-xs dark:text-gray-400"
                >
                  Name
                </TableCell>
                <TableCell
                  isHeader
                  className="px-5 py-3 font-medium text-gray-500 text-start text-theme-xs dark:text-gray-400"
                >
                  Email
                </TableCell>
                <TableCell
                  isHeader
                  className="px-5 py-3 font-medium text-gray-500 text-start text-theme-xs dark:text-gray-400"
                >
                  Phone
                </TableCell>
                <TableCell
                  isHeader
                  className="px-5 py-3 font-medium text-gray-500 text-start text-theme-xs dark:text-gray-400"
                >
                  Actions
                </TableCell>
              </TableRow>
            </TableHeader>

            <TableBody className="divide-y divide-gray-100 dark:divide-white/[0.05]">
              {clients.map((client) => (
                <TableRow key={client.id}>
                  <TableCell className="px-5 py-4 sm:px-6 text-start">
                    <Link
                      to={`/clients/${client.id}`}
                      className="block font-medium text-brand-500 hover:text-brand-600 hover:underline text-theme-sm"
                    >
                      {client.name}
                    </Link>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-gray-500 text-start text-theme-sm dark:text-gray-400">
                    <Link to={`/clients/${client.id}`} className="block">
                      {client.contact_email ?? "—"}
                    </Link>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-gray-500 text-start text-theme-sm dark:text-gray-400">
                    <Link to={`/clients/${client.id}`} className="block">
                      {client.phone ?? "—"}
                    </Link>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-gray-500 text-start text-theme-sm dark:text-gray-400">
                    <ClientRowActions client={client} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
