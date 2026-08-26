import PageMeta from "../components/common/PageMeta";
import CalendarCard from "../components/calendar/CalendarCard";

const Calendar: React.FC = () => {
  return (
    <>
      <PageMeta
        title="React.js Calendar Dashboard | AAV - Next.js Admin Dashboard Template"
        description="This is React.js Calendar Dashboard page for AAV - React.js Tailwind CSS Admin Dashboard Template"
      />
      <CalendarCard />
    </>
  );
};

export default Calendar;
