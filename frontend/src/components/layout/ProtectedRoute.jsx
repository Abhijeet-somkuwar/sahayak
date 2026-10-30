import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

// Staff screens need a signed-in user. While the session is being restored from the cookie, render nothing.
export default function ProtectedRoute({ children }) {
  const auth = useAuth();
  const location = useLocation();
  if (!auth.ready) return null;
  if (!auth.accessToken && !auth.locked) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return children;
}
