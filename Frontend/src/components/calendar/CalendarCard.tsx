import { useRef } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";

const CalendarCard: React.FC = () => {
  const calendarRef = useRef<FullCalendar>(null);

  const toDateKey = (date: Date) => date.toISOString().split("T")[0];

  // Mock count of applications received per day
  const applicationCounts: Record<string, number> = {
    [toDateKey(new Date())]: 5,
    [toDateKey(new Date(Date.now() + 86400000))]: 2,
    [toDateKey(new Date(Date.now() + 172800000))]: 8,
    [toDateKey(new Date(Date.now() + 345600000))]: 1,
    [toDateKey(new Date(Date.now() - 86400000))]: 3,
  };

  const renderDayCellContent = (arg: any) => {
    const count = applicationCounts[toDateKey(arg.date)];
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-0.5">
        <span>{arg.dayNumberText}</span>
        {count ? (
          <span className="rounded-full bg-brand-500 px-2 py-0.5 text-sm font-semibold leading-5 text-white">
            {count}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <div className="rounded-2xl border  border-gray-200 bg-white dark:border-gray-800 dark:bg-white/[0.03]">
      <div className="custom-calendar">
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{
            left: "prev,next",
            center: "title",
            right: "dayGridMonth,timeGridWeek,timeGridDay",
          }}
          selectable={false}
          dayCellContent={renderDayCellContent}
        />
      </div>
    </div>
  );
};

export default CalendarCard;
