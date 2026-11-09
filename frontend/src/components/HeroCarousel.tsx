import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

export interface Slide {
  id: string;
  emoji: string[];
  title: string;
  sub: string;
  cta: string;
  onClick: () => void;
}

const INTERVAL_MS = 5000;

/** Auto-rotating hero banner. Pauses on hover/focus and when the tab is hidden; no auto-rotate with reduced motion. */
export function HeroCarousel({ slides, label }: { slides: Slide[]; label: string }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const dragStart = useRef<number | null>(null);
  const n = slides.length;
  const go = useCallback((i: number) => setIndex(((i % n) + n) % n), [n]);

  useEffect(() => {
    if (paused || n < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      if (!document.hidden) setIndex((i) => (i + 1) % n);
    }, INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [paused, n]);

  const onPointerDown = (e: PointerEvent) => {
    dragStart.current = e.clientX;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (dragStart.current === null) return;
    const dx = e.clientX - dragStart.current;
    dragStart.current = null;
    if (Math.abs(dx) > 40) go(index + (dx < 0 ? 1 : -1));
  };

  return (
    <section
      className="carousel"
      aria-roledescription="carousel"
      aria-label={label}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(index + 1);
        if (e.key === "ArrowLeft") go(index - 1);
      }}
    >
      <div className="carousel__viewport" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => (dragStart.current = null)}>
        <div className="carousel__track" style={{ transform: `translateX(-${index * 100}%)` }}>
          {slides.map((s, i) => (
            <div
              key={s.id}
              className={`slide slide--${s.id}`}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} / ${n}`}
              aria-hidden={i !== index}
            >
              <div className="slide__text">
                <h2>{s.title}</h2>
                <p>{s.sub}</p>
                <button type="button" className="primary" tabIndex={i === index ? 0 : -1} onClick={s.onClick}>{s.cta}</button>
              </div>
              <div className="slide__art" aria-hidden>
                {s.emoji.map((e, k) => <span key={k}>{e}</span>)}
              </div>
            </div>
          ))}
        </div>
      </div>
      {n > 1 && (
        <>
          <button type="button" className="carousel__arrow carousel__arrow--prev" aria-label="previous" onClick={() => go(index - 1)}>‹</button>
          <button type="button" className="carousel__arrow carousel__arrow--next" aria-label="next" onClick={() => go(index + 1)}>›</button>
          <div className="carousel__dots">
            {slides.map((s, i) => (
              <button key={s.id} type="button" aria-label={`${i + 1}`} aria-current={i === index} className={i === index ? "active" : ""} onClick={() => go(i)} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
