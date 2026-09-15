import Link from "next/link";
import {
  MapPin,
  Phone,
  Mail,
  ShieldCheck,
  Truck,
  BadgeCheck,
  Clock,
} from "lucide-react";
import { Logo } from "./logo";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { megaCategories } from "@/lib/data/catalog";
import { useSettings } from "@/lib/settings";

const company: [string, string][] = [
  ["About KimSafety", "/about"],
  ["Why Choose Us", "/about"],
  ["Corporate Solutions", "/corporate"],
  ["Government & Tenders", "/corporate"],
  ["Careers", "/contact"],
  ["Blog & News", "/blog"],
];

const support: [string, string][] = [
  ["Help Center", "/support"],
  ["Track My Order", "/track"],
  ["Delivery & Pickup", "/support"],
  ["Returns & Refunds", "/account/returns"],
  ["Product Certifications", "/knowledge"],
  ["Contact Us", "/contact"],
];

const policies: [string, string][] = [
  ["Privacy Policy", "/privacy"],
  ["Terms & Conditions", "/terms"],
  ["Payment Methods", "/support"],
  ["Warranty Policy", "/support"],
  ["Quality Guarantee", "/about"],
  ["Sitemap", "/sitemap"],
];

const brands: [string, string][] = [
  ["3M", "/brands/3m"],
  ["Honeywell", "/brands/honeywell"],
  ["Ansell", "/brands/ansell"],
  ["Uvex", "/brands/uvex"],
  ["MSA", "/brands/msa"],
  ["Dräger", "/brands/draeger"],
  ["Karam", "/brands/karam"],
  ["Delta Plus", "/brands/delta-plus"],
];

export function Footer() {
  const { address, phone, email, whatsapp, site_name, hours } = useSettings();
  const tel = `tel:${phone.replace(/[^\d+]/g, "")}`;
  const wa = `https://wa.me/${whatsapp}`;
  return (
    <footer className="bg-navy-950 border-t border-navy-800 bg-navy-900 text-white">
      <div className="mx-auto max-w-shell px-4 lg:px-8">
        <div className="grid grid-cols-2 gap-10 border-b border-white/10 py-14 md:grid-cols-3 lg:grid-cols-6">
          <div className="col-span-2 lg:col-span-2">
            <Logo light />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/60">
              Kenya&apos;s most trusted supplier of certified industrial PPE, medical safety, fire safety
              and laboratory equipment — serving hospitals, industries and organizations nationwide.
            </p>
            <div className="mt-5 space-y-2.5 text-sm text-white/70">
              <p className="flex items-start gap-2.5">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-safety-400" />
                {address}
              </p>
              <p className="flex items-center gap-2.5">
                <Phone className="h-4 w-4 shrink-0 text-safety-400" />
                <a href={tel} className="hover:text-safety-400">{phone}</a>
              </p>
              <p className="flex items-center gap-2.5">
                <Mail className="h-4 w-4 shrink-0 text-safety-400" />
                <a href={`mailto:${email}`} className="hover:text-safety-400">{email}</a>
              </p>
              <p className="flex items-center gap-2.5">
                <WhatsAppIcon className="h-4 w-4 shrink-0 text-[#25D366]" />
                <a href={wa} target="_blank" rel="noopener noreferrer" className="hover:text-safety-400">
                  WhatsApp: {phone}
                </a>
              </p>
              <p className="flex items-center gap-2.5">
                <Clock className="h-4 w-4 shrink-0 text-safety-400" />
                {hours}
              </p>
            </div>
            <div className="mt-5 flex gap-2">
              {[
                ["Facebook", "https://facebook.com/kimsafetyltd", "M13.5 9H16V6h-2.5C11.6 6 10 7.6 10 9.5V11H8v3h2v7h3v-7h2.5l.5-3H13v-1.5c0-.3.2-.5.5-.5z"],
                ["Instagram", "https://instagram.com/kimsafetyltd", "M12 2c2.7 0 3 0 4.1.1 1 0 1.7.2 2.3.5.6.2 1.1.6 1.6 1 .4.5.8 1 1 1.6.3.6.4 1.3.5 2.3 0 1.1.1 1.4.1 4.1s0 3-.1 4.1c0 1-.2 1.7-.5 2.3-.2.6-.6 1.1-1 1.6-.5.4-1 .8-1.6 1-.6.3-1.3.4-2.3.5-1.1 0-1.4.1-4.1.1s-3 0-4.1-.1c-1 0-1.7-.2-2.3-.5-.6-.2-1.1-.6-1.6-1-.4-.5-.8-1-1-1.6-.3-.6-.4-1.3-.5-2.3C2 15 2 14.7 2 12s0-3 .1-4.1c0-1 .2-1.7.5-2.3.2-.6.6-1.1 1-1.6.5-.4 1-.8 1.6-1 .6-.3 1.3-.4 2.3-.5C9 2 9.3 2 12 2zm0 1.8c-2.7 0-3 0-4 .1-.9 0-1.4.2-1.7.3-.4.2-.7.4-1 .7-.3.3-.5.6-.7 1-.1.3-.3.8-.3 1.7-.1 1-.1 1.3-.1 4s0 3 .1 4c0 .9.2 1.4.3 1.7.2.4.4.7.7 1 .3.3.6.5 1 .7.3.1.8.3 1.7.3 1 .1 1.3.1 4 .1s3 0 4-.1c.9 0 1.4-.2 1.7-.3.4-.2.7-.4 1-.7.3-.3.5-.6.7-1 .1-.3.3-.8.3-1.7.1-1 .1-1.3.1-4s0-3-.1-4c0-.9-.2-1.4-.3-1.7-.2-.4-.4-.7-.7-1-.3-.3-.6-.5-1-.7-.3-.1-.8-.3-1.7-.3-1-.1-1.3-.1-4-.1zm0 3.1a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 1.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4zm5.2-3.1a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4z"],
                ["LinkedIn", "https://linkedin.com/company/kimsafetyltd", "M4.98 3.5C4.98 4.88 3.87 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.2 8h4.6v14H.2V8zm7.6 0h4.4v1.9h.1c.6-1.2 2.1-2.4 4.4-2.4 4.7 0 5.6 3.1 5.6 7.1V22h-4.6v-6.5c0-1.5 0-3.5-2.1-3.5s-2.5 1.7-2.5 3.4V22H7.8V8z"],
                ["YouTube", "https://youtube.com/@kimsafetyltd", "M23.5 6.2c-.3-1-1.1-1.8-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6c-1 .3-1.8 1.1-2.1 2.1C0 8.1 0 12 0 12s0 3.9.5 5.8c.3 1 1.1 1.8 2.1 2.1 1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6c1-.3 1.8-1.1 2.1-2.1.5-1.9.5-5.8.5-5.8s0-3.9-.5-5.8zM9.6 15.6V8.4l6.2 3.6-6.2 3.6z"],
              ].map(([label, href, path]) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${label} (@kimsafetyltd)`}
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 transition-colors hover:bg-safety-500"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
                    <path d={path} />
                  </svg>
                </a>
              ))}
            </div>
          </div>
          <FooterCol title="Company" links={company} />
          <FooterCol title="Support" links={support} />
          <FooterCol title="Policies" links={policies} />
          <FooterCol title="Brands" links={brands} />
        </div>

        <div className="grid grid-cols-2 gap-8 border-b border-white/10 py-10 md:grid-cols-3 lg:grid-cols-4">
          {megaCategories.slice(0, 4).map((cat) => (
            <div key={cat.title}>
              <h4 className="mb-3 text-xs font-bold uppercase tracking-wider text-white/50">{cat.title}</h4>
              <ul className="space-y-1.5">
                {cat.items.slice(0, 6).map((item) => (
                  <li key={item}>
                    <Link
                      href={`/search?q=${encodeURIComponent(item)}`}
                      className="text-[13px] text-white/60 transition-colors hover:text-safety-400"
                    >
                      {item}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center justify-between gap-6 py-8 lg:flex-row">
          <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-white/60">
            <span className="flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-emerald-400" /> Verified Genuine Products</span>
            <span className="flex items-center gap-1.5"><Truck className="h-4 w-4 text-safety-400" /> Nationwide Delivery</span>
            <span className="flex items-center gap-1.5"><BadgeCheck className="h-4 w-4 text-safety-400" /> KEBS Certified Stock</span>
            <span className="flex items-center gap-1.5"><Clock className="h-4 w-4 text-emerald-400" /> Mon–Sat 8am–6pm</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {["M-Pesa", "Visa", "Mastercard", "Paystack", "PO"].map((m) => (
              <span
                key={m}
                className="rounded-lg border border-white/15 px-3 py-1.5 text-[11px] font-bold text-white/70"
              >
                {m}
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-col items-center justify-between gap-3 border-t border-white/10 py-6 text-[11px] text-white/40 lg:flex-row">
          <p>© {new Date().getFullYear()} {site_name}. All rights reserved. RC: PVT-2024-8871</p>
          <p>Certified safety equipment · ISO 9001:2015 Compliant Operations</p>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <h4 className="mb-3 text-xs font-bold uppercase tracking-wider text-white/50">{title}</h4>
      <ul className="space-y-1.5">
        {links.map(([label, href]) => (
          <li key={label}>
            <Link href={href} className="text-[13px] text-white/60 transition-colors hover:text-safety-400">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
