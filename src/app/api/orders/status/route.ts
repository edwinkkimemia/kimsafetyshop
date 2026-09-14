import { NextResponse } from "next/server";
import { getOrderById, setOrderPaid, setMpesaTransaction } from "@/lib/db";
import { MPESA_COOLDOWN_MS, MPESA_MAX_ATTEMPTS, mpesaQueryCheckout, mpesaFetchReceipt } from "@/lib/payments/mpesa";
import { sendPaidInvoiceEmail } from "@/lib/mailer";
import { rateLimit, tooMany } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Per-instance throttle so parallel polls (checkout + track pages) don't
// hammer Daraja's query API for the same order.
const lastQueryAt = new Map<string, number>();
const QUERY_MIN_GAP_MS = 15_000;

/**
 * Public payment-status endpoint for the checkout confirmation / tracking
 * screens. Authorized by the one-time payment token returned when the order
 * was placed, so guests don't need an account to see their payment go through.
 *
 * M-Pesa resilience: besides reporting the stored state, if the order is still
 * unpaid but an STK push exists, we ACTIVELY QUERY Daraja for the transaction
 * status. The Safaricom callback can silently fail (callback URL unreachable,
 * stale env value), and without this fallback a completed payment would never
 * be picked up. On a confirmed ResultCode 0 the order flips to paid here —
 * exactly what the callback would have done.
 */
export async function GET(req: Request) {
  const rl = rateLimit(req, "orders-status", 30, 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const { searchParams } = new URL(req.url);
  const orderId = searchParams.get("orderId") ?? "";
  const token = searchParams.get("token") ?? "";
  if (!orderId || !token) return NextResponse.json({ error: "Missing orderId or token" }, { status: 400 });

  let order: Awaited<ReturnType<typeof getOrderById>>;
  try {
    order = await getOrderById(orderId);
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    const code = (err as { code?: string })?.code;
    if (code === "53300" || /too many connections/i.test(msg)) {
      // Under load don't 500 — tell checkout to keep polling (transient)
      return NextResponse.json({ paid: 0, transient: true, retryAfterMs: 5000 }, { headers: { "Cache-Control": "no-store" } });
    }
    throw err;
  }
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (!order.payment_token || token !== order.payment_token) {
    return NextResponse.json({ error: "Invalid payment token" }, { status: 403 });
  }

  // --- Active STK query fallback (unpaid M-Pesa orders with a live push) ---
  let queried = false;
  if (order.paid !== 1 && order.payment === "mpesa" && order.mpesa_checkout_id) {
    const pushedAt = order.mpesa_pushed_at ? new Date(order.mpesa_pushed_at).getTime() : 0;
    const now = Date.now();
    const lastQ = lastQueryAt.get(order.id) ?? 0;
    // Give the real callback ~20s to land first; then query at most every 15s.
    if (now - pushedAt > 20_000 && now - lastQ > QUERY_MIN_GAP_MS) {
      lastQueryAt.set(order.id, now);
      try {
        const q = await mpesaQueryCheckout(order.mpesa_checkout_id);
        queried = true;
        if (q.paid) {
          // The STK status query confirms payment but carries NO receipt
          // number. Ask Daraja's Transaction Status API for the actual code
          // BEFORE flagging paid, so the paid-invoice email/PDF and the admin
          // view show a real transaction ID instead of a blank.
          try {
            const receipt = await mpesaFetchReceipt(order.mpesa_checkout_id);
            if (receipt && !order.mpesa_transaction_id) {
              await setMpesaTransaction(order.id, receipt);
              order.mpesa_transaction_id = receipt;
            }
          } catch {
            /* best-effort — the late Safaricom callback or manual entry can still backfill */
          }
          await setOrderPaid(order.id, 1);
          const fresh = (await getOrderById(order.id)) ?? order;
          try {
            await sendPaidInvoiceEmail(fresh);
          } catch (err) {
            console.error(`[status] paid invoice email failed for ${order.id}:`, (err as Error).message);
          }
          Object.assign(order, fresh);
        } else if (q.resultCode && q.resultDesc && q.resultCode !== "1032") {
          // Record genuine failures (not 1032 = user-cancelled/pending) so the
          // UI can explain them. 1032 is treated as "still waiting".
          console.info(`[status] STK query ${order.id}: ${q.resultCode} ${q.resultDesc}`);
        }
      } catch (err) {
        // Query failures must never break the status endpoint.
        console.warn(`[status] STK query failed for ${order.id}:`, (err as Error).message);
      }
    }
  }

  // --- Self-heal receipt lookup ---
  // If an order was marked paid via the STK-query fallback (no receipt in that
  // response), keep retrying Daraja's Transaction Status API on later polls so
  // the blank reference auto-fills with the real M-Pesa receipt number
  // (e.g. TB17CVOCY9) once Daraja can answer.
  if (
    order.paid === 1 &&
    order.payment === "mpesa" &&
    !order.mpesa_transaction_id &&
    order.mpesa_checkout_id
  ) {
    const rKey = `receipt:${order.id}`;
    const lastR = lastQueryAt.get(rKey) ?? 0;
    if (Date.now() - lastR > QUERY_MIN_GAP_MS * 4) {
      lastQueryAt.set(rKey, Date.now());
      try {
        const receipt = await mpesaFetchReceipt(order.mpesa_checkout_id);
        if (receipt) {
          await setMpesaTransaction(order.id, receipt);
          order.mpesa_transaction_id = receipt;
          console.info(`[status] backfilled receipt ${receipt} for ${order.id}`);
        }
      } catch {
        /* best-effort — the late callback or manual entry can still fill it */
      }
    }
  }

  // Retry info for the M-Pesa "Resend STK push" flow: when the last push was
  // declined (mpesa_last_result set) or the cooldown hasn't elapsed, the
  // checkout screen uses these to render the failure reason + countdown.
  let canResend = false;
  let retryAfterMs = 0;
  if (order.paid !== 1 && order.payment === "mpesa") {
    const lastPushAt = order.mpesa_pushed_at ? new Date(order.mpesa_pushed_at).getTime() : 0;
    retryAfterMs = Math.max(0, MPESA_COOLDOWN_MS - (Date.now() - lastPushAt));
    canResend = (order.mpesa_push_count ?? 0) < MPESA_MAX_ATTEMPTS && retryAfterMs === 0;
  }
  return NextResponse.json({
    orderId: order.id,
    payment: order.payment,
    paid: order.paid,
    status: order.status,
    mpesaPushCount: order.mpesa_push_count ?? 0,
    mpesaLastResult: order.mpesa_last_result,
    mpesaLastResultDesc: order.mpesa_last_result_desc,
    // REAL transaction codes only (e.g. TB17CVOCY9 for M-Pesa, Paystack transaction ID)
    // No fallback to checkout ID / initialization reference.
    transactionId:
      order.payment === "mpesa"
        ? order.mpesa_transaction_id || null
        : order.paystack_transaction_id || null,
    canResend,
    retryAfterMs,
    queried,
  });
}
