import { BrowserRouter as Router, Routes, Route } from "react-router";
import SignIn from "./pages/AuthPages/SignIn";
import SignUp from "./pages/AuthPages/SignUp";
import NotFound from "./pages/OtherPage/NotFound";
import UserProfiles from "./pages/UserProfiles";
import Videos from "./pages/UiElements/Videos";
import Images from "./pages/UiElements/Images";
import Alerts from "./pages/UiElements/Alerts";
import Badges from "./pages/UiElements/Badges";
import Avatars from "./pages/UiElements/Avatars";
import Buttons from "./pages/UiElements/Buttons";
import LineChart from "./pages/Charts/LineChart";
import BarChart from "./pages/Charts/BarChart";
import Calendar from "./pages/Calendar";
import BasicTables from "./pages/Tables/BasicTables";
import FormElements from "./pages/Forms/FormElements";
import Blank from "./pages/Blank";
import UserManagement from "./pages/UserManagement";
import Applications from "./pages/Applications";
import Clients from "./pages/Clients";
import ClientDetail from "./pages/ClientDetail";
import AppLayout from "./layout/AppLayout";
import { ScrollToTop } from "./components/common/ScrollToTop";
import Home from "./pages/Dashboard/Home";
import { ApplicationsProvider } from "./context/ApplicationsContext";
import { ClientsProvider } from "./context/ClientsContext";
import { AuthProvider } from "./context/AuthContext";
import ProtectedRoute from "./components/auth/ProtectedRoute";
import PublicOnlyRoute from "./components/auth/PublicOnlyRoute";
import AdminOnlyRoute from "./components/auth/AdminOnlyRoute";

export default function App() {
  return (
    <AuthProvider>
      <ClientsProvider>
        <ApplicationsProvider>
          <Router>
            <ScrollToTop />
            <Routes>
            {/* Dashboard Layout */}
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<AppLayout />}>
                <Route index element={<Home />} />
                <Route path="applications" element={<Applications />} />
                <Route path="clients" element={<Clients />} />
                <Route path="clients/:clientId" element={<ClientDetail />} />

                {/* Others Page */}
                <Route path="profile" element={<UserProfiles />} />
                <Route path="calendar" element={<Calendar />} />
                <Route element={<AdminOnlyRoute />}>
                  <Route path="user-management" element={<UserManagement />} />
                </Route>
                <Route path="blank" element={<Blank />} />

                {/* Forms */}
                <Route path="form-elements" element={<FormElements />} />

                {/* Tables */}
                <Route path="basic-tables" element={<BasicTables />} />

                {/* Ui Elements */}
                <Route path="alerts" element={<Alerts />} />
                <Route path="avatars" element={<Avatars />} />
                <Route path="badge" element={<Badges />} />
                <Route path="buttons" element={<Buttons />} />
                <Route path="images" element={<Images />} />
                <Route path="videos" element={<Videos />} />

                {/* Charts */}
                <Route path="line-chart" element={<LineChart />} />
                <Route path="bar-chart" element={<BarChart />} />
              </Route>
            </Route>

            {/* Auth Layout */}
            <Route element={<PublicOnlyRoute />}>
              <Route path="/signin" element={<SignIn />} />
              <Route path="/signup" element={<SignUp />} />
            </Route>

            {/* Fallback Route */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Router>
        </ApplicationsProvider>
      </ClientsProvider>
    </AuthProvider>
  );
}
