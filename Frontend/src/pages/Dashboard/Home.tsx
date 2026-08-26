import EcommerceMetrics from "../../components/ecommerce/EcommerceMetrics";
import MonthlySalesChart from "../../components/ecommerce/MonthlySalesChart";
import CalendarCard from "../../components/calendar/CalendarCard";
import PageMeta from "../../components/common/PageMeta";

export default function Home() {
  return (
    <>
      <PageMeta
        title="React.js Ecommerce Dashboard | AAV - React.js Admin Dashboard Template"
        description="This is React.js Ecommerce Dashboard page for AAV - React.js Tailwind CSS Admin Dashboard Template"
      />
      <div className="grid grid-cols-12 gap-4 md:gap-6">
        <div className="col-span-12 space-y-6">
          <EcommerceMetrics />

          <MonthlySalesChart />

          <CalendarCard />
        </div>
      </div>
    </>
  );
}
