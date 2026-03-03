import { useEffect, useRef, useState, useCallback } from "react";

export function useActiveSection(ids: readonly string[]) {
  const [activeId, setActiveId] = useState(ids[0] || "");
  const observer = useRef<IntersectionObserver | null>(null);
  const isClickScrolling = useRef(false);
  const scrollTimeout = useRef<number | null>(null);

  useEffect(() => {
    observer.current?.disconnect();

    const intersecting = new Set<string>();

    observer.current = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            intersecting.add(e.target.id);
          } else {
            intersecting.delete(e.target.id);
          }
        }
        
        if (isClickScrolling.current) return;

        // Find the first id in our ordered list that is currently intersecting
        // the narrow band defined by rootMargin.
        for (const id of ids) {
          if (intersecting.has(id)) {
            setActiveId(id);
            break;
          }
        }
      },
      { 
        // We only care if it's intersecting our target area at all
        threshold: 0,
        // Create a band starting ~100px from top (under headers) down to 60% of viewport
        rootMargin: "-100px 0px -40% 0px" 
      }
    );

    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.current.observe(el);
    }

    return () => observer.current?.disconnect();
  }, [ids]);

  const setClickedId = useCallback((id: string) => {
    setActiveId(id);
    isClickScrolling.current = true;
    
    if (scrollTimeout.current) {
      window.clearTimeout(scrollTimeout.current);
    }
    
    // Assume smooth scrolling finishes within ~800ms
    scrollTimeout.current = window.setTimeout(() => {
      isClickScrolling.current = false;
    }, 800);
  }, []);

  return { activeId, setClickedId };
}
