import { useCallback, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { DatesSetArg } from "@fullcalendar/core";
import api from "../../lib/api";

const CalendarCard: React.FC = () => {
  const calendarRef = useRef<FullCalendar>(null);
  const [applicationCounts, setApplicationCounts] = useState<Record<string, number>>({});

  const toDateKey = (date: Date) => date.toISOString().split("T")[0];

  const handleDatesSet = useCallback((arg: DatesSetArg) => {
    // The visible month is the one the current view is centered on.
    const anchor = new Date((arg.view.currentStart.getTime() + arg.view.currentEnd.getTime()) / 2);
    const month = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, "0")}`;

    api
      .get<{ counts: Record<string, number> }>("/v1/dashboard/applications-by-day", {
        params: { month },
      })
      .then((res) => setApplicationCounts(res.data.counts))
      .catch(() => setApplicationCounts({}));
  }, []);

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
          datesSet={handleDatesSet}
        />
      </div>
    </div>
  );
};

export default CalendarCard;
