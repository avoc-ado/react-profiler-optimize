import { StatusBar } from "expo-status-bar";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

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

  // Footgun #1: interval-driven context churn triggers broad rerenders.
  useEffect(() => {
    const id = setInterval(() => {
      setTick((value) => value + 1);
      if (tick % 8 === 0) {
        setTheme((value) => (value === "light" ? "dark" : "light"));
      }
    }, 1000);
    return () => clearInterval(id);
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
  const [noop] = useState(0);
  void noop;

  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark("ExpensiveBadge:render");
  }

  let burn = 0;
  for (let i = 1; i <= 120000; i += 1) {
    burn += Math.sqrt(i) % 9;
  }

  return (
    <Text style={styles.description}>
      {label}: {Math.round(burn)}
    </Text>
  );
}

function TickReadout() {
  const { tick, theme } = useLabContext();
  return (
    <View style={styles.row}>
      <Text style={styles.secondary}>Tick: {tick}</Text>
      <Text style={styles.secondary}>Theme: {theme}</Text>
    </View>
  );
}

function ContextConsumerGrid() {
  const { tick } = useLabContext();

  return (
    <View style={styles.grid}>
      {Array.from({ length: 12 }).map((_, index) => (
        <Text key={index} style={styles.secondary}>
          consumer-{index + 1} / tick-{tick % 5}
        </Text>
      ))}
    </View>
  );
}

function BrokenMemoList() {
  const { items, tick, addItem } = useLabContext();
  const [search, setSearch] = useState("a");

  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark("BrokenMemoList:render");
  }

  const unstableMemoProps = { search };

  // Footgun #2: broken dependency is a new object every render.
  const visibleItems = useMemo(() => {
    const needle = search.toLowerCase();
    return items.filter((item) => item.toLowerCase().includes(needle));
  }, [unstableMemoProps, items]);

  return (
    <View style={styles.card} testID="broken-memo-list-card" nativeID="broken-memo-list-card">
      <Text style={styles.label}>Search list</Text>
      <TextInput
        testID="search-box"
        nativeID="search-box"
        accessibilityLabel="search-box"
        value={search}
        onChangeText={setSearch}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <Pressable
        testID="add-item-button"
        nativeID="add-item-button"
        accessibilityLabel="add-item-button"
        onPress={addItem}
        style={styles.button}
      >
        <Text style={styles.buttonText}>Add Item</Text>
      </Pressable>
      <Text style={styles.description}>tick snapshot in list: {tick}</Text>
      <View style={styles.list}>
        {visibleItems.map((item, index) => (
          <Text key={`${item}-${index}`} style={styles.listItem}>
            {item}
          </Text>
        ))}
      </View>
    </View>
  );
}

function LabShell() {
  // Intentionally consume context high in the tree to widen rerender scope.
  const { tick } = useLabContext();

  return (
    <ScrollView
      testID="lab-ready"
      nativeID="lab-ready"
      accessibilityLabel="lab-ready"
      contentContainerStyle={styles.container}
    >
      <Text style={styles.title}>Expo React Profiler Footguns</Text>
      <Text style={styles.description}>
        Record a profile for 8-12 seconds while idle, then type and add items.
      </Text>
      <Text style={styles.hidden}>shell-rerender-tick:{tick}</Text>
      <TickReadout />
      <ExpensiveBadge label="static-expensive-badge" />
      <BrokenMemoList />
      <ContextConsumerGrid />
      <StatusBar style="auto" />
    </ScrollView>
  );
}

export default function App() {
  return (
    <LabProvider>
      <LabShell />
    </LabProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingVertical: 40,
    gap: 16,
    backgroundColor: "#ffffff",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
  },
  description: {
    fontSize: 16,
    color: "#2c2c2c",
  },
  secondary: {
    fontSize: 14,
    color: "#4b5563",
  },
  row: {
    flexDirection: "row",
    gap: 12,
    flexWrap: "wrap",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  card: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 12,
    padding: 12,
    gap: 10,
    backgroundColor: "#f8fafc",
  },
  label: {
    fontWeight: "600",
    fontSize: 14,
  },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    backgroundColor: "#ffffff",
  },
  button: {
    alignSelf: "flex-start",
    backgroundColor: "#111827",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  buttonText: {
    color: "#ffffff",
    fontWeight: "600",
  },
  list: {
    gap: 6,
  },
  listItem: {
    fontSize: 15,
  },
  hidden: {
    opacity: 0,
    height: 0,
    width: 0,
  },
});
