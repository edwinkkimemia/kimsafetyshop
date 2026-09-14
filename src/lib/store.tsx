"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { CartItem, Product } from "./types";
import { getProduct } from "./data/products";
import { bulkUnitPrice } from "./utils";

type Store = {
  cart: CartItem[];
  wishlist: string[];
  compare: string[];
  addToCart: (productId: string, qty?: number) => void;
  removeFromCart: (productId: string) => void;
  setQty: (productId: string, qty: number) => void;
  clearCart: () => void;
  toggleWishlist: (productId: string) => void;
  toggleCompare: (productId: string) => void;
  cartCount: number;
  cartTotal: number;
  cartOldTotal: number;
  catalog: Product[];
  liveProduct: (productId: string) => Product | undefined;
  liveBySlug: (slug: string) => Product | undefined;
  recentlyViewed: string[];
  noteRecentlyViewed: (productId: string) => void;
  refreshCatalog: () => Promise<void>;
  delivery: { fee: number; threshold: number };
};

const StoreContext = createContext<Store | null>(null);

function load<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [wishlist, setWishlist] = useState<string[]>([]);
  const [compare, setCompare] = useState<string[]>([]);
  const [recentlyViewed, setRecentlyViewed] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<Product[]>([]);
  // Delivery fee / free-shipping threshold come from admin settings; these
  // defaults match the legacy hardcodes until the settings fetch lands.
  const [delivery, setDelivery] = useState({ fee: 350, threshold: 10000 });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setCart(load("ks-cart", []));
    setWishlist(load("ks-wishlist", []));
    setCompare(load("ks-compare", []));
    setRecentlyViewed(load("ks-recent", []));
    setHydrated(true);
  }, []);

  useEffect(() => {
    fetch("/api/catalog", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data?.products)) setCatalog(data.products);
      })
      .catch(() => setCatalog([]));
    // Public settings endpoint — powers the delivery fee / free-shipping text.
    // Reuse the shared settings fetcher (dedupes with useSettings) to avoid
    // the double /api/settings stampede seen at 17:44:36 (2× at same ms).
    import("@/lib/settings").then(({ fetchSettings }) =>
      fetchSettings()
        .then((s) => {
          const fee = Number(s?.delivery_fee);
          const threshold = Number(s?.free_delivery_threshold);
          setDelivery({
            fee: Number.isFinite(fee) && fee >= 0 ? fee : 350,
            threshold: Number.isFinite(threshold) && threshold >= 0 ? threshold : 10000,
          });
        })
        .catch(() => {})
    );
  }, []);

  // Re-fetches the live catalog so cart/checkout prices reflect admin price
  // changes made after this page was loaded. Cart and checkout call this on
  // mount — prices are never a snapshot taken at add-to-cart time.
  const refreshCatalog = useCallback(async () => {
    try {
      const res = await fetch("/api/catalog", { cache: "no-store" });
      const data = await res.json();
      if (Array.isArray(data?.products)) setCatalog(data.products);
    } catch {
      /* keep the current catalog on failure */
    }
  }, []);

  // Keeps listing pages honest while browsing without reload. Uses a longer
  // 2-minute interval and debounced focus handling to avoid the stampede seen
  // in logs (4× /api/settings at the same ms when tab regains focus).
  useEffect(() => {
    let pending = false;
    let lastSync = 0;
    const MIN_SYNC_GAP_MS = 120_000; // don't re-fetch catalog more than every 2 min
    const sync = () => {
      const now = Date.now();
      if (pending || document.visibilityState !== "visible") return;
      if (now - lastSync < MIN_SYNC_GAP_MS) return;
      pending = true;
      lastSync = now;
      refreshCatalog().finally(() => {
        pending = false;
      });
    };
    let focusDebounce: ReturnType<typeof setTimeout> | null = null;
    const onFocus = () => {
      if (focusDebounce) clearTimeout(focusDebounce);
      focusDebounce = setTimeout(sync, 1500); // debounce rapid focus/visibility bursts
    };
    const iv = setInterval(sync, 120_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(iv);
      if (focusDebounce) clearTimeout(focusDebounce);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshCatalog]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem("ks-cart", JSON.stringify(cart));
  }, [cart, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem("ks-wishlist", JSON.stringify(wishlist));
  }, [wishlist, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem("ks-compare", JSON.stringify(compare));
  }, [compare, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem("ks-recent", JSON.stringify(recentlyViewed));
  }, [recentlyViewed, hydrated]);

  const addToCart = useCallback(
    (productId: string, qty = 1) => {
      const p = catalog.find((pr) => pr.id === productId || pr.sku === productId) ?? getProduct(productId);
      const stock = p?.stock ?? 0;
      if (stock <= 0) {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("kimsafety:toast", { detail: { message: "Out of stock", type: "warning" } }));
        }
        return;
      }
      const cap = stock;
      const safeQty = Math.min(Math.max(1, Math.floor(qty)), cap);
      setCart((prev) => {
        const existing = prev.find((i) => i.productId === productId);
        if (existing) {
          return prev.map((i) =>
            i.productId === productId ? { ...i, qty: Math.min(i.qty + safeQty, cap) } : i
          );
        }
        return [...prev, { productId, qty: safeQty }];
      });
    },
    [catalog]
  );

  const removeFromCart = useCallback((productId: string) => {
    setCart((prev) => prev.filter((i) => i.productId !== productId));
  }, []);

  const setQty = useCallback(
    (productId: string, qty: number) => {
      const p = catalog.find((pr) => pr.id === productId || pr.sku === productId) ?? getProduct(productId);
      const cap = p?.stock ?? 0;
      if (cap <= 0) {
        setCart((prev) => prev.filter((i) => i.productId !== productId));
        return;
      }
      const safeQty = Math.min(Math.max(0, Math.floor(qty)), cap);
      setCart((prev) =>
        safeQty <= 0
          ? prev.filter((i) => i.productId !== productId)
          : prev.map((i) => (i.productId === productId ? { ...i, qty: safeQty } : i))
      );
    },
    [catalog]
  );

  const clearCart = useCallback(() => setCart([]), []);

  const toggleWishlist = useCallback((productId: string) => {
    setWishlist((prev) =>
      prev.includes(productId)
        ? prev.filter((id) => id !== productId)
        : [...prev, productId]
    );
  }, []);

  const toggleCompare = useCallback((productId: string) => {
    setCompare((prev) => {
      if (prev.includes(productId)) return prev.filter((id) => id !== productId);
      if (prev.length >= 4) {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("kimsafety:toast", { detail: { message: "Compare limit is 4 items. Remove one to add another.", type: "warning" } }));
        }
        return prev;
      }
      return [...prev, productId];
    });
  }, []);

  const noteRecentlyViewed = useCallback((productId: string) => {
    setRecentlyViewed((prev) =>
      [productId, ...prev.filter((id) => id !== productId)].slice(0, 8)
    );
  }, []);

  const cartCount = useMemo(() => cart.reduce((sum, i) => sum + i.qty, 0), [cart]);
  const liveProduct = useCallback(
    (productId: string) => catalog.find((p) => p.id === productId || p.sku === productId) ?? getProduct(productId),
    [catalog]
  );
  const liveBySlug = useCallback(
    (slug: string) =>
      catalog.find(
        (p) => p.slug === slug || p.sku === slug || p.id === slug
      ) ?? getProduct(slug),
    [catalog]
  );
  const cartTotal = useMemo(
    () =>
      cart.reduce((sum, i) => sum + bulkUnitPrice(liveProduct(i.productId) ?? { price: 0 }, i.qty) * i.qty, 0),
    [cart, liveProduct]
  );
  const cartOldTotal = useMemo(() => {
    let sum = 0;
    for (const i of cart) {
      const p = liveProduct(i.productId);
      if (!p) continue;
      const oldPrice = p.oldPrice != null && p.oldPrice > p.price ? p.oldPrice : p.price;
      sum += oldPrice * i.qty;
    }
    return sum;
  }, [cart, liveProduct]);

  const value = useMemo(
    () => ({
      cart,
      wishlist,
      compare,
      addToCart,
      removeFromCart,
      setQty,
      clearCart,
      toggleWishlist,
      toggleCompare,
      cartCount,
      cartTotal,
      cartOldTotal,
      catalog,
      liveProduct,
      liveBySlug,
      recentlyViewed,
      noteRecentlyViewed,
      refreshCatalog,
      delivery,
    }),
    [
      delivery,

      cart,
      wishlist,
      compare,
      addToCart,
      removeFromCart,
      setQty,
      clearCart,
      toggleWishlist,
      toggleCompare,
      cartCount,
      cartTotal,
      cartOldTotal,
      catalog,
      liveProduct,
      liveBySlug,
      recentlyViewed,
      noteRecentlyViewed,
      refreshCatalog,
    ]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
