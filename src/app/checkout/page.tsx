"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, Lock, Truck, ArrowRight, Package, Loader2, Download, FileUp, CircleAlert, Smartphone } from "lucide-react";
import { useStore } from "@/lib/store";
import { formatKES, bulkUnitPrice, cn } from "@/lib/utils";
import { ProductArt } from "@/components/product/product-art";
import { PageHeader } from "@/components/layout/page-header";

const steps = ["Contact", "Delivery", "Payment", "Review"];

// Common M-Pesa STK callback ResultCodes → human-friendly decline reasons.
const MPESA_DECLINE: Record<string, string> = {
  "1032": "The request was cancelled or timed out",
  "1037": "The request timed out — no PIN was entered",
  "2001": "Insufficient funds in the M-Pesa account",
  "1035": "An invalid M-Pesa PIN was entered",
  "1036": "The M-Pesa PIN was incorrect",
  "1031": "Invalid M-Pesa account details",
};

export default function CheckoutPage() {
  const { cart, cartTotal, cartOldTotal, clearCart, liveProduct, refreshCatalog, delivery } = useStore();

  // Re-sync with the live catalog on mount so the amounts shown (and sent to
  // the payment prompt) match the server-side prices charged at order creation.
  useEffect(() => {
    refreshCatalog().catch(() => {});
  }, [refreshCatalog]);
  const [step, setStep] = useState(0);
  const [placed, setPlaced] = useState(false);
  const [payment, setPayment] = useState("mpesa");
  const [momo, setMomo] = useState("");
  const [poFile, setPoFile] = useState("");
  const [poFileName, setPoFileName] = useState("");
  const [uploadingPo, setUploadingPo] = useState(false);
  const [poError, setPoError] = useState("");
  const [form, setForm] = useState({ first: "", last: "", email: "", phone: "", county: "Nairobi", town: "", address: "", notes: "", po: "", company: "" });
  const [orderId, setOrderId] = useState<string | null>(null);
  const [paymentToken, setPaymentToken] = useState<string | null>(null);
  const [placedTotal, setPlacedTotal] = useState(0);
  const [placing, setPlacing] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [paidNow, setPaidNow] = useState(false);
  // Gateway transaction reference (M-Pesa receipt / Paystack ref) surfaced by
  // the status poll so the confirmation screen can show it immediately.
  const [paidRef, setPaidRef] = useState<string | null>(null);
  const [pollDone, setPollDone] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [pushFailed, setPushFailed] = useState<string | null>(null);
  const [retryIn, setRetryIn] = useState(0);
  const [pushAttempts, setPushAttempts] = useState(0);
  const [pushBlocked, setPushBlocked] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isStaff, setIsStaff] = useState(false);
  const [waiveFee, setWaiveFee] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [wantAccount, setWantAccount] = useState(false);
  const [guestPassword, setGuestPassword] = useState("");
  const [referral, setReferral] = useState("");

  const prefillDone = useRef(false);
  useEffect(() => {
    if (prefillDone.current) return;
    prefillDone.current = true;
    const urlRef = new URLSearchParams(window.location.search).get("ref");
    if (urlRef?.trim()) setReferral(urlRef.trim());
    // Sequential to avoid 3 concurrent DB connections on checkout mount (was Promise.all).
    // Stagger slightly so they don't all land at same ms as /api/settings + /api/catalog.
    (async () => {
      const sess = await fetch("/api/auth/session").then((r) => r.json()).catch(() => ({}));
      const addrData = await fetch("/api/addresses").then((r) => (r.ok ? r.json() : { addresses: [] })).catch(() => ({ addresses: [] }));
      const ordData = await fetch("/api/orders").then((r) => (r.ok ? r.json() : { orders: [] })).catch(() => ({ orders: [] }));
      return [sess, addrData, ordData] as const;
    })().then(([sess, addrData, ordData]) => {
      const user = (sess as { user?: { name?: string; email?: string; phone?: string | null; role?: string } }).user;
      if (user) setSignedIn(true);
      if (user?.role === "admin" || user?.role === "superadmin") {
        setIsStaff(true);
        // Staff checkouts default to NO delivery fee — it's the exception for
        // staff-placed (pickup / corporate) orders. Flip the toggle to include it.
        setWaiveFee(true);
      }
      const rawAddresses = (addrData as { addresses?: unknown }).addresses;
      const addresses = Array.isArray(rawAddresses) ? (rawAddresses as { is_default: number; name: string; phone: string; address_line: string; city: string; county: string }[]) : [];
      const orders = (ordData as { orders?: { address?: string }[] }).orders ?? [];
      const saved = addresses.find((a) => a.is_default === 1) ?? addresses[0];

      let oCounty = "", oTown = "", oAddress = "";
      const lastOrderAddress = orders[0]?.address;
      if (lastOrderAddress) {
        const parts = lastOrderAddress.split(", ").map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 3) {
          oCounty = parts.pop()!;
          oTown = parts.pop()!;
          oAddress = parts.join(", ");
        } else if (parts.length === 2) {
          oCounty = parts[1];
          oAddress = parts[0];
        } else {
          oAddress = parts[0] ?? "";
        }
      }

      const fullName = user?.name || saved?.name || "";
      const nameParts = fullName.trim().split(/\s+/).filter(Boolean);
      const phone = user?.phone || saved?.phone || "";

      setForm((prev) => ({
        ...prev,
        first: prev.first || nameParts[0] || "",
        last: prev.last || nameParts.slice(1).join(" ") || "",
        email: prev.email || user?.email || "",
        phone: prev.phone || phone,
        county: prev.county || saved?.county || oCounty || "Nairobi",
        town: prev.town || saved?.city || oTown || "",
        address: prev.address || saved?.address_line || oAddress || "",
      }));
      const cleanPhone = phone.replace(/[\s-]/g, "");
      if (/^(\+?254|0)\d{9}$/.test(cleanPhone)) setMomo(cleanPhone);
    });
  }, []);

  const savings = cartOldTotal - cartTotal;
  const { fee: deliveryFee, threshold: freeThreshold } = delivery;
  const freeDelivery = freeThreshold > 0 && cartTotal >= freeThreshold;
  const shipping = cart.length === 0 ? 0 : waiveFee || freeDelivery ? 0 : deliveryFee;
  const total = cartTotal + shipping;

  const field =
    "w-full rounded-xl border border-line bg-white px-3.5 py-3 text-sm outline-none transition-all focus:border-safety-400 focus:ring-4 focus:ring-safety-500/10";
  const errField =
    "w-full rounded-xl border border-danger bg-white px-3.5 py-3 text-sm outline-none transition-all focus:border-danger focus:ring-4 focus:ring-danger/10";
  const fieldCls = (k: string) => (errors[k] ? errField : field);
  const errMsg = (k: string) =>
    errors[k] ? <p className="text-xs font-semibold text-danger">{errors[k]}</p> : null;

  const placeOrder = async () => {
    setPlacing(true);
    setOrderError(null);
    setPayError(null);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${form.first} ${form.last}`.trim(),
          email: form.email,
          phone: form.phone,
          address: `${form.address}, ${form.town}, ${form.county}`,
          payment,
          company: form.company.trim(),
          po_ref: form.po.trim(),
          po_file: poFile,
          momo: momo.trim(),
          total,
          delivery_fee: !waiveFee,
          marketing_opt_in: marketing,
          guest_password: wantAccount && !signedIn ? guestPassword : undefined,
          referral_code: referral,
          items: cart.map((i) => {
            const p = liveProduct(i.productId);
            return { productId: i.productId, name: p?.name ?? i.productId, qty: i.qty, price: p?.price ?? 0 };
          }),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to place order");
      setOrderId(json.order?.id ?? null);
      setPaymentToken(json.order?.payment_token ?? null);
      // Pin the authoritative total before clearing the cart — after this the
      // derived `total` would be 0 and the thank-you screen would show "Ksh 0".
      setPlacedTotal(json.order?.total ?? total);
      setPlaced(true);
      clearCart();
      // Order placed — stop abandoned-cart tracking for this email.
      if (form.email.trim()) {
        fetch("/api/cart/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: form.email.trim(), items: [] }),
        }).catch(() => {});
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
      if (payment !== "po" && json.order?.id && json.order?.payment_token) {
        startPayment(json.order.id, json.order.payment_token);
      }
    } catch (err) {
      setOrderError(err instanceof Error ? err.message : "Failed to place order. Please try again.");
    } finally {
      setPlacing(false);
    }
  };

  const startPayment = async (id: string, token: string) => {
    try {
      const res = await fetch("/api/payments/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: id, token }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Payment could not be started");
      if (json.method === "card" && json.authorizationUrl) {
        window.location.assign(json.authorizationUrl);
      }
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "Payment could not be started. Contact us on WhatsApp for help.");
    }
  };

  // Poll the M-Pesa status endpoint until the STK callback confirms payment.
  // Stops early on a decline or after 2 minutes. Interval 5s (was 3s) to avoid
  // hammering Postgres under burst (3s × many checkouts = 53300).
  useEffect(() => {
    if (!placed || payment !== "mpesa" || paidNow || pollDone) return;
    let cancelled = false;
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`/api/orders/status?orderId=${encodeURIComponent(orderId ?? "")}&token=${encodeURIComponent(paymentToken ?? "")}`);
        const j = await r.json();
        if (cancelled) return;
        if (j.transient) {
          // DB overloaded (53300) — back off silently, keep polling
          return;
        }
        if (j.paid === 1) {
          setPaidNow(true);
          setPaidRef(j.transactionId ?? null);
          setPollDone(true);
          clearInterval(iv);
          return;
        }
        setPushAttempts(j.mpesaPushCount ?? 0);
        setPushBlocked((j.mpesaPushCount ?? 0) >= 5);
        setRetryIn(j.retryAfterMs ? Math.ceil(j.retryAfterMs / 1000) : 0);
        const lastResult = j.mpesaLastResult && j.mpesaLastResult !== "0" ? String(j.mpesaLastResult) : null;
        if (lastResult) {
          setPushFailed(MPESA_DECLINE[lastResult] ?? j.mpesaLastResultDesc ?? "The payment was declined");
          setPollDone(true);
          clearInterval(iv);
        }
      } catch {
        /* transient network error — keep polling */
      }
    }, 5000);
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setPollDone(true);
        clearInterval(iv);
      }
    }, 120_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
      clearTimeout(timeout);
    };
  }, [placed, payment, orderId, paymentToken, paidNow, pollDone]);

  // Ticks the "Resend STK push" cooldown countdown down to zero.
  useEffect(() => {
    if (retryIn <= 0) return;
    const iv = setInterval(() => setRetryIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(iv);
  }, [retryIn]);

  const resendStk = async () => {
    if (resending || !orderId || !paymentToken) return;
    setResending(true);
    setResendError(null);
    try {
      const res = await fetch("/api/payments/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, token: paymentToken }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 429) {
          if (json.retryAfterMs) setRetryIn(Math.ceil(json.retryAfterMs / 1000));
          if (json.maxAttempts) setPushBlocked(true);
        }
        setResendError(json.error ?? "Please try again in a moment.");
        return;
      }
      // New push is on its way — clear the decline state and restart polling.
      setPushFailed(null);
      setResendError(null);
      setPushAttempts(json.attempts ?? pushAttempts + 1);
      setRetryIn(json.retryAfterMs ? Math.ceil(json.retryAfterMs / 1000) : 0);
      setPushBlocked(false);
      setPollDone(false);
    } catch (err) {
      setResendError(err instanceof Error ? err.message : "Payment could not be started. Contact us on WhatsApp for help.");
    } finally {
      setResending(false);
    }
  };

  const retryCard = async () => {
    if (!orderId || !paymentToken) return;
    setPayError(null);
    try {
      const res = await fetch("/api/payments/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, token: paymentToken }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Payment could not be started");
      if (json.method === "card" && json.authorizationUrl) {
        window.location.assign(json.authorizationUrl);
      }
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "Payment could not be started. Contact us on WhatsApp for help.");
    }
  };

  const next = async () => {
    const errs: Record<string, string> = {};
    if (step === 0) {
      if (!form.first.trim()) errs.first = "First name is required";
      if (!form.last.trim()) errs.last = "Last name is required";
      if (!form.email.trim()) errs.email = "Email address is required";
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errs.email = "Enter a valid email address";
      if (!form.phone.trim()) errs.phone = "Phone number is required";
      else if (!/^(\+?\d{9,13})$/.test(form.phone.replace(/[\s-]/g, ""))) errs.phone = "Enter a valid phone number";
    }
    if (step === 1) {
      if (!form.town.trim()) errs.town = "Town / area is required";
      if (!form.address.trim()) errs.address = "Street / building / estate is required";
    }
    if (step === 2 && payment === "mpesa") {
      if (!momo.trim()) errs.momo = "M-Pesa number is required";
      else if (!/^(\+?254|0)\d{9}$/.test(momo.replace(/[\s-]/g, ""))) errs.momo = "Enter a valid M-Pesa number, e.g. 07XX XXX XXX";
    }
    if (step === 2 && payment === "po") {
      if (!form.company.trim()) errs.company = "Company name is required";
      if (!form.po.trim()) errs.po = "PO number is required";
      if (!poFile) errs.poFile = "Upload the purchase order document (PDF)";
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    // Leaving the contact step means we have an email — snapshot the cart for
    // abandoned-cart recovery. Fire-and-forget: must never block checkout.
    if (step === 0 && form.email.trim()) {
      fetch("/api/cart/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.email.trim(),
          name: `${form.first} ${form.last}`.trim(),
          phone: form.phone,
          items: cart.map((i) => ({ productId: i.productId, qty: i.qty })),
        }),
      }).catch(() => {});
    }
    if (step < steps.length - 1) setStep(step + 1);
    else await placeOrder();
  };

  const clearErr = (k: string) => setErrors((prev) => (prev[k] ? { ...prev, [k]: "" } : prev));

  const handlePoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingPo(true);
    setPoError("");
    try {
      const fd = new FormData();
      fd.append("files", file);
      const res = await fetch("/api/uploads/documents", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Upload failed");
      setPoFile(d.urls?.[0] ?? "");
      setPoFileName(file.name);
      clearErr("poFile");
    } catch (err) {
      setPoError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingPo(false);
    }
  };

  const summaryItems = useMemo(
    () => cart.map((i) => ({ product: liveProduct(i.productId), qty: i.qty })).filter((i) => i.product),
    [cart, liveProduct]
  );

  if (placed) {
    const waitingMpesa = payment === "mpesa" && !paidNow && !payError;
    const mpesaStillWaiting = waitingMpesa && !pollDone && !pushFailed;
    const mpesaNeedsAttention = waitingMpesa && !mpesaStillWaiting;
    return (
      <div className="flex flex-col items-center gap-4 bg-surface px-4 py-24 text-center">
        <div className={cn("flex h-24 w-24 items-center justify-center rounded-full", paidNow ? "bg-emerald-50" : "bg-amber-50")}>
          {paidNow ? (
            <Check className="h-12 w-12 text-emerald-600" />
          ) : mpesaStillWaiting ? (
            <Loader2 className="h-12 w-12 animate-spin text-amber-500" />
          ) : (
            <CircleAlert className="h-12 w-12 text-amber-500" />
          )}
        </div>
        <span className="rounded-full bg-emerald-50 px-4 py-1.5 text-xs font-bold text-emerald-700">
          Order #{orderId ?? `KS-${Math.floor(10000 + Math.random() * 89999)}`}
        </span>
        <h1 className="font-display text-3xl font-extrabold text-navy-900">Thank you for your order!</h1>
        <p className="max-w-md text-sm text-gray-500">
          A confirmation has been sent to <strong>{form.email || "your email"}</strong>. You&apos;ll receive
          a dispatch notification once your order leaves our Nairobi warehouse.
        </p>
        {mpesaStillWaiting && (
          <p className="max-w-md text-sm text-gray-600">
            An STK push was sent to <strong>{momo}</strong> for {formatKES(placedTotal)} — enter your M-Pesa PIN to
            confirm the payment.
          </p>
        )}
        {payError && (
          <p className="max-w-md rounded-xl bg-red-50 px-4 py-3 text-xs font-semibold text-danger">{payError}</p>
        )}
        {payment === "card" && !paidNow && (
          <div className="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-5 text-left shadow-card">
            <p className="text-sm font-bold text-navy-900">Card payment not completed</p>
            <p className="mt-1 text-xs leading-relaxed text-gray-600">
              Your order is placed but the card payment hasn&apos;t been confirmed yet. Try again below — you&apos;ll be
              redirected to Paystack&apos;s secure payment page.
            </p>
            <div className="mt-3">
              <button
                onClick={retryCard}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-navy-900 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-safety-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Lock className="h-4 w-4" /> Retry card payment · {formatKES(placedTotal)}
              </button>
            </div>
          </div>
        )}
        {mpesaNeedsAttention && (
          <div className="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-5 text-left shadow-card">
            <p className="text-sm font-bold text-navy-900">M-Pesa payment needs your attention</p>
            <p className="mt-1 text-xs leading-relaxed text-gray-600">
              {pushFailed ? (
                <>
                  M-Pesa responded: <strong className="text-danger">{pushFailed}</strong>. You can try once more — a
                  new prompt will be sent to <strong>{momo}</strong>.
                </>
              ) : (
                <>
                  We haven&apos;t received confirmation from M-Pesa yet. Check your phone for the prompt, or send the
                  push again to <strong>{momo}</strong>.
                </>
              )}
            </p>
            {pushBlocked ? (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-danger">
                All M-Pesa attempts have been used. Please contact us on WhatsApp to complete this payment — your
                order is safe.
              </p>
            ) : (
              <div className="mt-3">
                <button
                  onClick={resendStk}
                  disabled={resending || retryIn > 0}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-navy-900 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-safety-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {resending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Sending push…
                    </>
                  ) : retryIn > 0 ? (
                    <>Resend STK push in {retryIn}s</>
                  ) : (
                    <>
                      <Smartphone className="h-4 w-4" /> Resend STK push to {momo}
                      {pushAttempts > 0 ? ` (${pushAttempts}/5 used)` : ""}
                    </>
                  )}
                </button>
                {resendError && (
                  <p className="mt-2 text-center text-xs font-semibold text-danger">{resendError}</p>
                )}
              </div>
            )}
          </div>
        )}
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-bold",
            paidNow ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
          )}
        >
          {paidNow ? <Check className="h-3.5 w-3.5" /> : mpesaStillWaiting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleAlert className="h-3.5 w-3.5" />}
          {paidNow
            ? "Payment received — invoice marked PAID"
            : mpesaStillWaiting
              ? "Waiting for M-Pesa confirmation…"
              : "Payment pending — invoice marked UNPAID"}
        </span>
        {paidNow && paidRef && (
          <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-2.5 text-xs font-semibold text-emerald-700">
            Transaction ID: <span className="font-mono">{paidRef}</span>
          </p>
        )}
        <div className="mt-2 flex flex-wrap justify-center gap-3">
          <a
            href={`/api/orders/${orderId ?? ""}/invoice?token=${encodeURIComponent(paymentToken ?? "")}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-4 py-2 text-xs font-bold text-navy-900 hover:bg-surface"
          >
            <Download className="h-3.5 w-3.5" /> Download Invoice
          </a>
          <Link href="/account" className="rounded-xl border border-line bg-white px-7 py-3.5 text-sm font-bold text-navy-900 hover:bg-surface">
            Track Order
          </Link>
          <Link href="/search" className="rounded-xl border border-line bg-white px-7 py-3.5 text-sm font-bold text-navy-900 hover:bg-surface">
            Continue Shopping
          </Link>
        </div>
      </div>
    );
  }

  if (cart.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 bg-surface px-4 py-24 text-center">
        <Package className="h-12 w-12 text-gray-300" />
        <h1 className="font-display text-2xl font-extrabold text-navy-900">Nothing to check out</h1>
        <Link href="/search" className="rounded-xl bg-safety-500 px-7 py-3.5 text-sm font-bold text-white hover:bg-safety-600">
          Browse Products
        </Link>
      </div>
    );
  }

  return (
    <div className="bg-surface pb-20">
      <PageHeader bg="/images/hero/hero3.jpg" title="Checkout">
        <ol className="mt-6 flex flex-wrap items-center gap-2 text-xs font-bold" aria-label="Checkout progress">
            {steps.map((label, i) => (
              <li key={label} className="flex items-center gap-2 text-white/80">
                <span
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full border-2",
                    i < step
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : i === step
                        ? "border-safety-500 bg-safety-500 text-white"
                        : "border-white/20 text-white/40"
                  )}
                >
                  {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                {label}
                {i < steps.length - 1 && <span className="h-0.5 w-6 rounded bg-white/20" />}
              </li>
            ))}
          </ol>
      </PageHeader>

      <div className="mx-auto grid max-w-shell grid-cols-1 gap-8 px-4 pt-8 lg:grid-cols-3 lg:px-8">
        <div className="space-y-6 lg:col-span-2">
          {step === 0 && (
            <section className="rounded-2xl border border-line bg-white p-6 shadow-card">
              <h2 className="font-display text-lg font-extrabold text-navy-900">Contact details</h2>
              <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <input required placeholder="First name *" className={fieldCls("first")} value={form.first} onChange={(e) => { setForm({ ...form, first: e.target.value }); clearErr("first"); }} />
                  {errMsg("first")}
                </div>
                <div className="space-y-1.5">
                  <input required placeholder="Last name *" className={fieldCls("last")} value={form.last} onChange={(e) => { setForm({ ...form, last: e.target.value }); clearErr("last"); }} />
                  {errMsg("last")}
                </div>
                <div className="space-y-1.5">
                  <input required type="email" placeholder="Email address *" className={fieldCls("email")} value={form.email} onChange={(e) => { setForm({ ...form, email: e.target.value }); clearErr("email"); }} />
                  {errMsg("email")}
                </div>
                <div className="space-y-1.5">
                  <input required type="tel" placeholder="Phone (M-Pesa number) *" className={fieldCls("phone")} value={form.phone} onChange={(e) => { setForm({ ...form, phone: e.target.value }); clearErr("phone"); }} />
                  {errMsg("phone")}
                </div>
              </div>

              {!signedIn && (
                <div className="mt-5 space-y-4 rounded-xl bg-surface p-4">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={wantAccount}
                      onChange={(e) => setWantAccount(e.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-safety-500"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-sm font-bold text-navy-900">Create an account with this checkout</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-gray-500">
                        Track every order, download invoices and request quotations — your guest orders
                        (past and future) are attached to the new account automatically.
                      </span>
                    </span>
                  </label>
                  {wantAccount && (
                    <input
                      type="password"
                      minLength={6}
                      placeholder="Choose a password (min 6 characters)"
                      value={guestPassword}
                      onChange={(e) => setGuestPassword(e.target.value)}
                      className={field}
                    />
                  )}
                </div>
              )}

              <label className="mt-5 flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={marketing}
                  onChange={(e) => setMarketing(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-safety-500"
                />
                <span className="min-w-0 flex-1 text-xs leading-relaxed text-gray-500">
                  <span className="font-bold text-navy-900">Keep me updated</span> — occasional safety
                  briefings, product news and offers from KimSafety. Unsubscribe anytime.
                </span>
              </label>

              {referral && (
                <p className="mt-4 flex items-center gap-1.5 rounded-lg bg-safety-50 px-3.5 py-2.5 text-xs font-semibold text-safety-700">
                  <Check className="h-3.5 w-3.5" /> Referral code {referral} applied — thanks for shopping with a friend.
                </p>
              )}
            </section>
          )}

          {step === 1 && (
            <section className="rounded-2xl border border-line bg-white p-6 shadow-card">
              <h2 className="font-display text-lg font-extrabold text-navy-900">Delivery details</h2>
              <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <select className={field} value={form.county} onChange={(e) => setForm({ ...form, county: e.target.value })}>
                  {["Nairobi", "Mombasa", "Kisumu", "Nakuru", "Eldoret", "Thika", "Machakos", "Other"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <input placeholder="Town / area *" className={fieldCls("town")} value={form.town} onChange={(e) => { setForm({ ...form, town: e.target.value }); clearErr("town"); }} />
                <input placeholder="Street / building / estate *" className={fieldCls("address")} value={form.address} onChange={(e) => { setForm({ ...form, address: e.target.value }); clearErr("address"); }} />
                <textarea placeholder="Delivery notes (optional)" rows={3} className={cn(field, "sm:col-span-2")} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                {errMsg("town")}
                {errMsg("address")}
              </div>
              {isStaff && (
                <div className="mt-5 space-y-3">
                  <button
                    type="button"
                    onClick={() => setWaiveFee((v) => !v)}
                    className="flex w-full items-center gap-2.5 rounded-xl border-2 border-line bg-white px-4 py-3 text-left transition-colors hover:border-safety-300"
                  >
                    <span
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2",
                        waiveFee ? "border-safety-500 bg-safety-500" : "border-gray-300 bg-white"
                      )}
                    >
                      {waiveFee && <Check className="h-3 w-3 text-white" />}
                    </span>
                    <span className="text-xs font-bold text-navy-900">
                      {waiveFee ? "Delivery fee waived (pickup / account rate)" : `Include delivery fee (KES ${delivery.fee.toLocaleString("en-KE")})`}
                    </span>
                  </button>
                  <p className="text-[11px] text-gray-400">Staff checkout — choose whether to charge the delivery fee on this order.</p>
                </div>
              )}
              <div className="mt-5 flex items-center gap-2.5 rounded-xl bg-safety-50 px-4 py-3 text-xs font-semibold text-safety-700">
                <Truck className="h-4 w-4" />
                {waiveFee
                  ? "Delivery fee waived for this order"
                  : freeDelivery
                    ? "Free same-day delivery within Nairobi unlocked"
                    : freeThreshold > 0
                      ? `Same-day delivery within Nairobi (${formatKES(deliveryFee)}) · Free over ${formatKES(freeThreshold)}`
                      : `Same-day delivery within Nairobi (${formatKES(deliveryFee)})`}
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="rounded-2xl border border-line bg-white p-6 shadow-card">
              <h2 className="font-display text-lg font-extrabold text-navy-900">Payment method</h2>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[
                  ["mpesa", "M-Pesa", "Pay instantly via STK push — most popular"],
                  ["card", "Card", "Visa & Mastercard via Paystack"],
                  ["po", "Purchase Order", "B2B & corporate — pay in 30 days"],
                ].map(([value, label, sub]) => (
                  <button
                    key={value}
                    onClick={() => setPayment(value)}
                    className={cn(
                      "rounded-2xl border-2 p-4 text-left transition-all",
                      payment === value ? "border-safety-500 bg-safety-50" : "border-line hover:border-safety-300"
                    )}
                  >
                    <p className="text-sm font-bold text-navy-900">{label}</p>
                    <p className="mt-0.5 text-[11px] text-gray-400">{sub}</p>
                  </button>
                ))}
              </div>
              <div className="mt-5 rounded-2xl bg-surface p-5">
                {payment === "mpesa" && (
                  <div>
                    <p className="mb-2 text-sm font-bold text-navy-900">Enter M-Pesa phone number</p>
                    <input
                      type="tel"
                      placeholder="07XX XXX XXX"
                      className={fieldCls("momo")}
                      value={momo}
                      onChange={(e) => { setMomo(e.target.value); clearErr("momo"); }}
                    />
                    {errMsg("momo")}
                    <p className="mt-2 text-xs text-gray-400">
                      You&apos;ll receive an STK push on this number to authorize {formatKES(total)}.
                    </p>
                  </div>
                )}
                {payment === "card" && (
                  <p className="text-sm text-gray-500">
                    You&apos;ll be redirected to Paystack&apos;s secure payment page to complete your card payment.
                    Your order is placed and stays unpaid until the payment is confirmed.
                  </p>
                )}
                {payment === "po" && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <input
                          placeholder="Company name (required)"
                          className={fieldCls("company")}
                          value={form.company}
                          onChange={(e) => { setForm({ ...form, company: e.target.value }); clearErr("company"); }}
                        />
                        {errMsg("company")}
                      </div>
                      <div className="space-y-1.5">
                        <input
                          placeholder="PO number (required)"
                          className={fieldCls("po")}
                          value={form.po}
                          onChange={(e) => { setForm({ ...form, po: e.target.value }); clearErr("po"); }}
                        />
                        {errMsg("po")}
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <p className="text-sm font-bold text-navy-900">Upload purchase order document *</p>
                      <label
                        className={cn(
                          "flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-5 text-sm font-semibold transition-colors",
                          errors.poFile
                            ? "border-danger bg-red-50/50 text-danger"
                            : poFile
                              ? "border-emerald-400 bg-emerald-50/60 text-emerald-700"
                              : "border-line text-gray-500 hover:border-safety-400 hover:text-safety-600"
                        )}
                      >
                        <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="sr-only" onChange={handlePoUpload} />
                        {uploadingPo ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : poFile ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <FileUp className="h-4 w-4" />
                        )}
                        {uploadingPo ? "Uploading…" : poFile ? `Attached: ${poFileName || "purchase order"}` : "Click to upload PDF of the purchase order (max 10MB)"}
                      </label>
                      {errMsg("poFile")}
                      {poError && <p className="text-xs font-semibold text-danger">{poError}</p>}
                      {poFile && (
                        <a href={poFile} target="_blank" rel="noopener noreferrer" className="text-xs font-bold text-safety-600 hover:underline">
                          View uploaded document →
                        </a>
                      )}
                    </div>
                    <p className="text-xs text-gray-400">
                      Purchase orders are invoiced with 30-day terms. We&apos;ll verify the document and send the
                      proforma invoice for sign-off.
                    </p>
                  </div>
                )}
              </div>
            </section>
          )}

          {step === 3 && (
            <section className="rounded-2xl border border-line bg-white p-6 shadow-card">
              <h2 className="font-display text-lg font-extrabold text-navy-900">Review & confirm</h2>
              <dl className="mt-4 space-y-2.5 rounded-2xl bg-surface p-5 text-sm">
                <div className="flex justify-between"><dt className="text-gray-500">Contact</dt><dd className="font-bold text-navy-900">{form.first} {form.last} · {form.phone}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Deliver to</dt><dd className="text-right font-bold text-navy-900">{form.town}, {form.county}<br /><span className="text-xs font-normal text-gray-400">{form.address}</span></dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Payment</dt><dd className="font-bold text-navy-900 capitalize">{payment === "mpesa" ? `M-Pesa ${momo || ""}` : payment === "po" ? `Purchase Order${form.po ? ` · ${form.po}` : ""}` : payment.replace("-", " ")}</dd></div>
                <div className="flex justify-between text-emerald-600"><dt>Delivery fee</dt><dd className="font-bold">{shipping === 0 ? "FREE" : formatKES(shipping)}</dd></div>
                {payment === "po" && form.company && (
                  <div className="flex justify-between"><dt className="text-gray-500">Company</dt><dd className="font-bold text-navy-900">{form.company}</dd></div>
                )}
              </dl>
              <ul className="mt-5 max-h-56 space-y-3 overflow-auto pr-1">
                {summaryItems.map(({ product, qty }) => (
                  <li key={product!.id} className="flex items-center gap-3">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg">
                      <ProductArt tags={product!.tags} categoryName={product!.categoryName} brand={product!.brand} sku={product!.sku} name={product!.name} className="h-full w-full" src={(product!).image || undefined} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-navy-900">{product!.name}</p>
                      <p className="text-[11px] text-gray-400">Qty {qty}</p>
                    </div>
                    <span className="text-sm font-bold text-navy-900">{formatKES(bulkUnitPrice(product!, qty) * qty)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="flex items-center justify-between">
            {step > 0 ? (
              <button onClick={() => setStep(step - 1)} className="rounded-xl border border-line bg-white px-6 py-3 text-sm font-bold text-navy-900 hover:bg-surface">
                ← Back
              </button>
            ) : (
              <Link href="/cart" className="rounded-xl border border-line bg-white px-6 py-3 text-sm font-bold text-navy-900 hover:bg-surface">
                ← Back to cart
              </Link>
            )}
            <button
              onClick={next}
              disabled={placing}
              className="inline-flex items-center gap-2 rounded-xl bg-safety-500 px-8 py-3.5 text-sm font-bold text-white shadow-[0_8px_24px_rgba(245,124,0,0.35)] transition-colors hover:bg-safety-600 disabled:opacity-60"
            >
              {step === steps.length - 1 ? (
                placing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Lock className="h-4 w-4" />
                )
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
              {step === steps.length - 1
                ? placing ? "Placing order…" : `Place Order · ${formatKES(total)}`
                : "Continue"}
            </button>
          </div>
          {orderError && (
            <p className="rounded-xl bg-red-50 px-4 py-3 text-xs font-semibold text-danger">{orderError}</p>
          )}
        </div>

        <aside className="h-fit rounded-2xl border border-line bg-white p-6 shadow-card lg:sticky lg:top-28">
          <h2 className="font-display text-lg font-extrabold text-navy-900">Order Summary</h2>
          <ul className="mt-4 max-h-64 space-y-3 overflow-auto pr-1">
            {summaryItems.map(({ product, qty }) => (
              <li key={product!.id} className="flex items-center gap-3">
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg">
                  <ProductArt tags={product!.tags} categoryName={product!.categoryName} brand={product!.brand} sku={product!.sku} name={product!.name} className="h-full w-full" src={(product!).image || undefined} />
                </div>
                <p className="min-w-0 flex-1 truncate text-xs font-semibold text-navy-900">
                  {product!.name}
                  <span className="block text-[10px] font-normal text-gray-400">× {qty}</span>
                </p>
                <span className="text-xs font-bold text-navy-900">{formatKES(bulkUnitPrice(product!, qty) * qty)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-4 space-y-2.5 border-t border-line pt-4 text-sm">
            <div className="flex justify-between"><dt className="text-gray-500">Subtotal (full price)</dt><dd className="font-bold">{formatKES(cartOldTotal)}</dd></div>
            {savings > 0 && <div className="flex justify-between text-emerald-600"><dt>Discount</dt><dd className="font-bold">-{formatKES(savings)}</dd></div>}
            <div className="flex justify-between"><dt className="text-gray-500">Delivery</dt><dd className="font-bold">{shipping === 0 ? "FREE" : formatKES(shipping)}</dd></div>
            <div className="flex justify-between border-t border-line pt-3"><dt className="font-bold text-navy-900">Total (after discount)</dt><dd className="font-display text-xl font-extrabold text-navy-900">{formatKES(total)}</dd></div>
          </dl>
          {isStaff && (
            <div className="mt-4 rounded-xl border border-line bg-surface p-3">
              <button
                type="button"
                onClick={() => setWaiveFee((v) => !v)}
                className="flex w-full items-center justify-between gap-2 text-left"
              >
                <span className="flex items-center gap-2.5 text-xs font-bold text-navy-900">
                  <span
                    className={cn(
                      "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border-2",
                      waiveFee ? "border-safety-500 bg-safety-500" : "border-gray-300 bg-white"
                    )}
                  >
                    {waiveFee && <Check className="h-3 w-3 text-white" />}
                  </span>
                  {waiveFee ? "Delivery fee waived" : `Include delivery fee (KES ${delivery.fee.toLocaleString("en-KE")})`}
                </span>
                <Truck className={cn("h-4 w-4", waiveFee ? "text-gray-300" : "text-safety-600")} />
              </button>
              <p className="mt-1.5 pl-[30px] text-[10px] leading-relaxed text-gray-400">
                Staff checkout — fee is applied to the final total, M-Pesa push, Paystack charge and PO invoice only when included.
              </p>
            </div>
          )}
          <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-gray-400">
            <Lock className="h-3 w-3" /> Encrypted & secure checkout · PCI-DSS compliant
          </p>
        </aside>
      </div>
    </div>
  );
}
