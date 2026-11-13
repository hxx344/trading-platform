import { useEffect, useState } from 'react';
import { parseRoute, type Route } from './route-parse.ts';

export { pairHref, type Route } from './route-parse.ts';

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const changed = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', changed);
    return () => removeEventListener('hashchange', changed);
  }, []);
  return route;
}
