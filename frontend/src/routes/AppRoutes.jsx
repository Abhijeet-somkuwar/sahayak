import { Navigate, Route, Routes } from 'react-router-dom';
import PatientLayout from '../components/layout/PatientLayout';
import StaffLayout from '../components/layout/StaffLayout';
import ProtectedRoute from '../components/layout/ProtectedRoute';
import FacilityPage from '../pages/patient/FacilityPage';
import OtpPage from '../pages/patient/OtpPage';
import StartPage from '../pages/patient/StartPage';
import IntakePage from '../pages/patient/IntakePage';
import SlipPage from '../pages/patient/SlipPage';
import MyVisitsPage from '../pages/patient/MyVisitsPage';
import KioskPage from '../pages/patient/KioskPage';
import LoginPage from '../pages/staff/LoginPage';
import CounterPage from '../pages/staff/CounterPage';
import DoctorPage from '../pages/staff/DoctorPage';
import CasualtyPage from '../pages/staff/CasualtyPage';
import DisplayPage from '../pages/staff/DisplayPage';
import DemoGuidePage from '../demo/DemoGuidePage';

const DEFAULT_FACILITY = import.meta.env.VITE_DEFAULT_FACILITY || 'CHA';

// All routes of the app. Patient screens share PatientLayout; staff screens share StaffLayout and need a sign-in.
export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={`/f/${DEFAULT_FACILITY}`} replace />} />

      <Route element={<PatientLayout />}>
        <Route path="/f/:facilityCode" element={<FacilityPage />} />
        <Route path="/f/:facilityCode/otp" element={<OtpPage />} />
        <Route path="/f/:facilityCode/start" element={<StartPage />} />
        <Route path="/f/:facilityCode/visits" element={<MyVisitsPage />} />
        <Route path="/intake/:sessionId" element={<IntakePage />} />
        <Route path="/t/:publicRef" element={<SlipPage />} />
      </Route>

      <Route path="/kiosk" element={<KioskPage />} />
      <Route path="/display" element={<DisplayPage />} />

      <Route path="/demo" element={<DemoGuidePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <ProtectedRoute>
            <StaffLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/counter" element={<CounterPage />} />
        <Route path="/doctor" element={<DoctorPage />} />
        <Route path="/ed" element={<CasualtyPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
