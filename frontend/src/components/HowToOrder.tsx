import { useEffect, useRef, useState } from "react";

const STEP_MS = 5000;

const TEXT = {
  ja: {
    title: "ご注文の流れ",
    steps: [
      { icon: "💬", title: "話しかける", sub: "食べたいものを一言で" },
      { icon: "🤖", title: "AIが選ぶ", sub: "好み・アレルギーに合わせて" },
      { icon: "✅", title: "確認して支払う", sub: "ボタンを押すのはあなただけ" },
      { icon: "🛵", title: "お届け", sub: "領収書もすぐ確認" },
    ],
    ask: "今日はお寿司が食べたい",
    agent: "お好きなサーモンの手巻き寿司はいかがですか？カートに入れました。",
    item: "サーモン手巻き寿司セット",
    reason: "サーモン好き・えび除外",
    delivery: "明日 12:00 · 会社",
    total: "合計",
    pay: "確認して支払う",
    done: "ご注文ありがとうございます",
    order: "注文番号",
    eta: "明日 12:00〜12:30 にお届け",
    invoice: "領収書を見る",
    cta: "やってみる",
    replay: "もう一度",
  },
  en: {
    title: "How to order",
    steps: [
      { icon: "💬", title: "Say it", sub: "One line is enough" },
      { icon: "🤖", title: "AI picks", sub: "Fits your taste and allergies" },
      { icon: "✅", title: "Confirm & pay", sub: "Only you press the button" },
      { icon: "🛵", title: "Delivered", sub: "Invoice ready right away" },
    ],
    ask: "I want sushi today",
    agent: "How about salmon hand rolls? You like salmon. It's in your cart.",
    item: "Salmon hand roll set",
    reason: "Likes salmon · no shrimp",
    delivery: "Tomorrow 12:00 · Office",
    total: "Total",
    pay: "Confirm & Pay",
    done: "Thank you for your order",
    order: "Order",
    eta: "Arrives tomorrow 12:00–12:30",
    invoice: "View invoice",
    cta: "Try it",
    replay: "Replay",
  },
};

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Typewriter for the step-1 message; restarts whenever `run` changes to true. */
function useTyping(text: string, run: boolean) {
  const [n, setN] = useState(text.length);
  useEffect(() => {
    if (!run || reducedMotion()) return setN(text.length);
    setN(0);
    const id = window.setInterval(() => setN((v) => (v >= text.length ? v : v + 1)), 90);
    return () => window.clearInterval(id);
  }, [text, run]);
  return text.slice(0, n);
}

/** Interactive "how to order": 4 steps, each with a small animated mock of the real screen. */
export function HowToOrder({ locale, onTry }: { locale: "ja" | "en"; onTry: (message: string) => void }) {
  const L = TEXT[locale];
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const typed = useTyping(L.ask, visible && step === 0);

  // Start only when the section is on screen, so the first step is not already over when the user scrolls to it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || !visible || reducedMotion()) return;
    const id = window.setTimeout(() => {
      if (step === L.steps.length - 1) setPlaying(false);
      else setStep(step + 1);
    }, STEP_MS);
    return () => window.clearTimeout(id);
  }, [step, playing, visible, L.steps.length]);

  const pick = (i: number) => {
    setStep(i);
    setPlaying(false);
  };
  const replay = () => {
    setStep(0);
    setPlaying(true);
  };

  return (
    <section className="howto" ref={ref} aria-labelledby="howto-title">
      <h2 id="howto-title">{L.title}</h2>
      <div className="howto__body">
        <ol className="howto__steps" role="tablist" aria-orientation="vertical">
          {L.steps.map((s, i) => (
            <li key={s.title} role="presentation">
              <button
                type="button"
                role="tab"
                id={`howto-tab-${i}`}
                aria-selected={i === step}
                aria-controls="howto-screen"
                className={i === step ? "active" : i < step ? "done" : ""}
                onClick={() => pick(i)}
              >
                <span className="howto__num" aria-hidden>{i < step ? "✓" : i + 1}</span>
                <span className="howto__label">
                  <strong>{s.icon} {s.title}</strong>
                  <span className="muted small">{s.sub}</span>
                </span>
                {i === step && playing && visible && <span className="howto__progress" style={{ animationDuration: `${STEP_MS}ms` }} aria-hidden />}
              </button>
            </li>
          ))}
        </ol>

        <div className="howto__screen" id="howto-screen" role="tabpanel" aria-labelledby={`howto-tab-${step}`} aria-live="polite">
          <div className="mock" key={step}>
            {step === 0 && (
              <>
                <div className="mock__bubble mock__bubble--user">{typed}<span className="mock__caret" aria-hidden /></div>
              </>
            )}
            {step === 1 && (
              <>
                <div className="mock__bubble mock__bubble--user">{L.ask}</div>
                <div className="mock__bubble mock__bubble--agent pop">{L.agent}</div>
                <div className="mock__card pop pop--2">
                  <span className="mock__emoji" aria-hidden>🍣</span>
                  <span>
                    <strong>{L.item}</strong>
                    <span className="mock__reason">♥ {L.reason}</span>
                  </span>
                  <strong>¥1,200</strong>
                </div>
              </>
            )}
            {step === 2 && (
              <div className="mock__confirm pop">
                <div className="mock__row"><span>🍣 {L.item}</span><span>¥1,200</span></div>
                <div className="mock__row muted"><span>🛵 {L.delivery}</span><span>¥330</span></div>
                <div className="mock__row muted"><span>🎟 LUNCH100</span><span>−¥100</span></div>
                <div className="mock__row mock__total"><span>{L.total}</span><span>¥1,430</span></div>
                <div className="mock__pay">{L.pay}<span className="mock__tap" aria-hidden /></div>
              </div>
            )}
            {step === 3 && (
              <div className="mock__receipt pop">
                <div className="mock__check" aria-hidden>✓</div>
                <strong>{L.done}</strong>
                <span className="muted small">{L.order} ORD-20261110-0042</span>
                <span>🛵 {L.eta}</span>
                <span className="mock__link">🧾 {L.invoice}</span>
              </div>
            )}
          </div>
          <div className="howto__actions">
            {!playing && <button type="button" onClick={replay}>↻ {L.replay}</button>}
            <button type="button" className="primary" onClick={() => onTry(L.ask)}>💬 {L.cta}</button>
          </div>
        </div>
      </div>
    </section>
  );
}
