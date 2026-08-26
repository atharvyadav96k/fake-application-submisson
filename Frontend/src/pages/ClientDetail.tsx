import { useParams, Link } from "react-router";
import PageBreadcrumb from "../components/common/PageBreadCrumb";
import ComponentCard from "../components/common/ComponentCard";
import PageMeta from "../components/common/PageMeta";
import ApplicationsTable from "../components/tables/ApplicationsTable";
import { useApplications } from "../context/ApplicationsContext";
import { useClients } from "../context/ClientsContext";

export default function ClientDetail() {
  const { clientId } = useParams<{ clientId: string }>();
  const { applications } = useApplications();
  const { clients } = useClients();

  const client = clients.find((c) => c.id === clientId);
  const clientApplications = applications.filter(
    (application) => application.clientId === clientId
  );

  if (!client) {
    return (
      <>
        <PageMeta
          title="Client Not Found | AAV - React.js Admin Dashboard Template"
          description="Client not found"
        />
        <PageBreadcrumb pageTitle="Client Not Found" />
        <ComponentCard title="Client Not Found">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            We couldn&apos;t find that client.{" "}
            <Link to="/clients" className="text-brand-500 hover:underline">
              Back to Clients
            </Link>
          </p>
        </ComponentCard>
      </>
    );
  }

  return (
    <>
      <PageMeta
        title={`${client.name} | AAV - React.js Admin Dashboard Template`}
        description={`Applications submitted for ${client.name}`}
      />
      <PageBreadcrumb pageTitle={client.name} />
      <div className="space-y-6">
        <ComponentCard title="Client Details">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <span className="block text-sm text-gray-500 dark:text-gray-400">
                Name
              </span>
              <span className="block font-medium text-gray-800 dark:text-white/90">
                {client.name}
              </span>
            </div>
            <div>
              <span className="block text-sm text-gray-500 dark:text-gray-400">
                Email
              </span>
              <span className="block font-medium text-gray-800 dark:text-white/90">
                {client.contact_email ?? "—"}
              </span>
            </div>
            <div>
              <span className="block text-sm text-gray-500 dark:text-gray-400">
                Phone
              </span>
              <span className="block font-medium text-gray-800 dark:text-white/90">
                {client.phone ?? "—"}
              </span>
            </div>
          </div>
        </ComponentCard>

        <ComponentCard title="Applications">
          {clientApplications.length > 0 ? (
            <ApplicationsTable
              applications={clientApplications}
              showClientColumn={false}
            />
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No applications have been logged for this client yet.
            </p>
          )}
        </ComponentCard>
      </div>
    </>
  );
}
