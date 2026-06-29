import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// Remembers each path's scroll position so Back/Forward (POP) restores where the
// user was — e.g. returning from an agg-history page to the expanded blame list —
// while a fresh navigation (PUSH/REPLACE) still starts at the top.
const scrollPositions = {};

function ScrollToTop() {
  const { pathname } = useLocation();
  const navType = useNavigationType();

  useEffect(() => {
    if (navType === 'POP') {
      const y = scrollPositions[pathname] ?? 0;
      // Restore after the restored page has painted (content is rendered from
      // in-memory caches synchronously, so the target offset already exists).
      requestAnimationFrame(() => window.scrollTo(0, y));
    } else {
      window.scrollTo(0, 0);
    }
  }, [pathname, navType]);

  // Continuously record the current path's scroll offset so it's available when
  // we later navigate back to it.
  useEffect(() => {
    const onScroll = () => { scrollPositions[pathname] = window.scrollY; };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [pathname]);

  return null;
}

export default ScrollToTop;
