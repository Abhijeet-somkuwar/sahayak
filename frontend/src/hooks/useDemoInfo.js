import { useEffect, useState } from 'react';
import { getDemoInfo } from '../api/dev';

// One request per page load, shared by every component that asks. null = not a development backend.
let cache = null;
const load = () => {
  cache = cache || getDemoInfo().catch(() => null);
  return cache;
};

/** The demo logins, password and device keys from the development backend, or null in production. */
export function useDemoInfo() {
  const [info, setInfo] = useState(undefined); // undefined while loading
  useEffect(() => {
    let alive = true;
    load().then((d) => alive && setInfo(d));
    return () => {
      alive = false;
    };
  }, []);
  return info;
}
