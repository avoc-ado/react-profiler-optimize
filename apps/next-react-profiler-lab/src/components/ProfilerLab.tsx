"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import styles from "../app/page.module.css";

type LabContextValue = {
  tick: number;
  theme: "light" | "dark";
  items: string[];
  addItem: () => void;
};

const LabContext = createContext<LabContextValue | null>(null);

function useLabContext() {
  const context = useContext(LabContext);
  if (!context) {
    throw new Error("useLabContext must be used inside LabProvider");
  }
  return context;
}

function LabProvider({ children }: { children: React.ReactNode }) {
  const [tick, setTick] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [items, setItems] = useState(["Alpha", "Beta", "Gamma"]);

  // Footgun #1: interval-driven context churn triggers provider value updates every second.
  useEffect(() => {
    const id = window.setInterval(() => {
      setTick((value) => value + 1);
      if (tick % 8 === 0) {
        setTheme((value) => (value === "light" ? "dark" : "light"));
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [tick]);

  const addItem = () => {
    setItems((value) => [...value, `Item-${value.length + 1}`]);
  };

  const value: LabContextValue = {
    tick,
    theme,
    items,
    addItem,
  };

  return <LabContext.Provider value={value}>{children}</LabContext.Provider>;
}

function ExpensiveBadge({ label }: { label: string }) {
  // Footgun #3: expensive child intentionally not wrapped in React.memo.
  // Keep a benign hook so component-level render tracking is visible in React tracks.
  const [noop] = useState(0);
  void noop;

  if (typeof performance !== "undefined") {
    performance.mark("ExpensiveBadge:render");
  }

  let burn = 0;
  for (let i = 1; i <= 120000; i += 1) {
    burn += Math.sqrt(i) % 9;
  }

  return (
    <p className={styles.description}>
      {label}: {Math.round(burn)}
    </p>
  );
}

function TickReadout() {
  const { tick, theme } = useLabContext();
  return (
    <div className={styles.ctas}>
      <span className={styles.secondary}>Tick: {tick}</span>
      <span className={styles.secondary}>Theme: {theme}</span>
    </div>
  );
}

function ContextConsumerGrid() {
  const { tick } = useLabContext();

  return (
    <div className={styles.ctas}>
      {Array.from({ length: 12 }).map((_, index) => (
        <span key={index} className={styles.secondary}>
          consumer-{index + 1} / tick-{tick % 5}
        </span>
      ))}
    </div>
  );
}

function BrokenMemoList() {
  const { items, tick, addItem } = useLabContext();
  const [search, setSearch] = useState("a");

  if (typeof performance !== "undefined") {
    performance.mark("BrokenMemoList:render");
  }

  const unstableMemoProps = { search };

  // Footgun #2: broken useMemo dependency uses a new object every render.
  const visibleItems = useMemo(() => {
    const needle = search.toLowerCase();
    return items.filter((item) => item.toLowerCase().includes(needle));
  }, [unstableMemoProps, items]);

  return (
    <div className={styles.intro}>
      <label htmlFor="search-box">Search list</label>
      <input
        id="search-box"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <button onClick={addItem}>Add Item</button>
      <p className={styles.description}>tick snapshot in list: {tick}</p>
      <ul>
        {visibleItems.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function ProfilerLab() {
  return (
    <LabProvider>
      <LabShell />
    </LabProvider>
  );
}

function LabShell() {
  // Intentionally consume context at a high level so descendants rerender frequently.
  const { tick } = useLabContext();

  return (
    <main className={styles.main}>
      <h1>Next.js React Profiler Footguns</h1>
      <p className={styles.description}>
        Open Chrome Performance panel and record for 8-12 seconds.
      </p>
      <p className={styles.description} style={{ display: "none" }}>
        shell-rerender-tick:{tick}
      </p>
      <TickReadout />
      <ExpensiveBadge label="static-expensive-badge" />
      <BrokenMemoList />
      <ContextConsumerGrid />
    </main>
  );
}
