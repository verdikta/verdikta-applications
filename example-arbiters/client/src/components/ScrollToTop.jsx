import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// Remembers each path's scroll position so Back/Forward (POP) restores where the
// user was — e.g. returning from an agg-history page to the expanded blame list —
// while a fresh navigation (PUSH/REPLACE) still starts at the top.
const scrollPositions = {};

function ScrollToTop() {
  const { pathname } = useLocation();
  const navType = useNavigationType();

  // Continuously record the current path's scroll offset so it's available when
  // we later navigate back to it.
  useEffect(() => {
    const onScroll = () => { scrollPositions[pathname] = window.scrollY; };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [pathname]);

  useEffect(() => {
    if (navType !== 'POP') {
      window.scrollTo(0, 0);
      return;
    }
    const targetY = scrollPositions[pathname] ?? 0;
    if (targetY <= 0) {
      window.scrollTo(0, 0);
      return;
    }

    // On Back/Forward the destination page re-mounts and some sections reload
    // (spinner → content), so the document is initially too short to reach the
    // saved offset. Re-apply the scroll every frame until the page has grown
    // tall enough (or a 2s budget elapses), and stop if the user scrolls.
    let cancelled = false;
    const startedAt = performance.now();
    const step = () => {
      if (cancelled) return;
      const maxY = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.min(targetY, Math.max(0, maxY)));
      if (maxY < targetY && performance.now() - startedAt < 2000) {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);

    const abort = () => { cancelled = true; };
    window.addEventListener('wheel', abort, { passive: true });
    window.addEventListener('touchmove', abort, { passive: true });
    window.addEventListener('keydown', abort);
    return () => {
      cancelled = true;
      window.removeEventListener('wheel', abort);
      window.removeEventListener('touchmove', abort);
      window.removeEventListener('keydown', abort);
    };
  }, [pathname, navType]);

  return null;
}

export default ScrollToTop;
