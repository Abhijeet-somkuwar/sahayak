import { ConfigProvider } from 'antd';
import { PrefsProvider } from './context/PrefsContext';
import { AuthProvider } from './context/AuthContext';
import { PatientSessionProvider } from './context/PatientSessionContext';
import { DeviceProvider } from './context/DeviceContext';
import { SocketProvider } from './context/SocketContext';
import { antdTheme } from './config/theme';
import AppRoutes from './routes/AppRoutes';
import DemoPanel from './demo/DemoPanel';

// Root component: preferences → staff auth → patient OTP session → device key → realtime status → theme → routes.
// DemoPanel renders only against a development backend (it hides itself when /dev/demo does not exist).
export default function App() {
  return (
    <PrefsProvider>
      <AuthProvider>
        <PatientSessionProvider>
          <DeviceProvider>
            <SocketProvider>
              <ConfigProvider theme={antdTheme}>
                <AppRoutes />
                <DemoPanel />
              </ConfigProvider>
            </SocketProvider>
          </DeviceProvider>
        </PatientSessionProvider>
      </AuthProvider>
    </PrefsProvider>
  );
}
