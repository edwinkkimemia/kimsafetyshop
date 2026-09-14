import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { StoreProvider } from "@/lib/store";
import { StorefrontChrome } from "@/components/layout/storefront-chrome";
import { siteUrl } from "@/lib/site";
import { getAllSettings } from "@/lib/db";
import { resolveLogoUrl, DEFAULT_LOGO } from "@/lib/logo";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
});

// Branding comes from the `settings` table (Admin -> Settings) so a logo or
// site-name change reflects everywhere, including structured data. The DB call
// is guarded so a static build without a live database still falls back to the
// bundled defaults instead of failing.
async function loadBrand(): Promise<{ site_name: string; logo: string; email: string; phone: string }> {
  try {
    const s = await getAllSettings();
    return {
      site_name: (s.site_name || "KimSafety").trim(),
      logo: resolveLogoUrl(s),
      email: s.email || "sales@kimsafety.co.ke",
      phone: s.phone || "+254 715135141",
    };
  } catch {
    return {
      site_name: "KimSafety",
      logo: DEFAULT_LOGO,
      email: "sales@kimsafety.co.ke",
      phone: "+254 715135141",
    };
  }
}

const absoluteUrl = (p: string) => (p.startsWith("http") ? p : `${siteUrl}${p}`);

// Live product count so metadata never goes stale as the catalog grows.
const productCount = async () => {
  const { getProductCount } = await import("@/lib/catalog");
  return getProductCount();
};

export async function generateMetadata(): Promise<Metadata> {
  const count = await productCount();
  return {
    metadataBase: new URL(siteUrl),
    title: {
      default: "KimSafety — Industrial & Medical Safety Equipment Supplier in Kenya",
      template: "%s | KimSafety",
    },
    description: `Kenya's trusted marketplace for certified industrial PPE, medical safety, fire safety, road safety and laboratory equipment. ${count} products, bulk discounts, same-day Nairobi delivery, corporate procurement support. Serving 1,200+ organizations across 47 counties.`,
    keywords: [
      "safety equipment Kenya",
      "PPE Kenya",
      "industrial safety Nairobi",
      "fire extinguishers Kenya",
      "medical gloves Kenya",
      "safety helmets Kenya",
      "lab equipment Kenya",
      "KimSafety",
      "safety boots Kenya",
      "reflective vest Kenya",
      "first aid kit Kenya",
      "construction safety Kenya",
    ],
    alternates: {
      canonical: siteUrl,
      languages: {
        "en-KE": siteUrl,
        "en": siteUrl,
      },
    },
    verification: process.env.NEXT_PUBLIC_GOOGLE_VERIFICATION
      ? { google: process.env.NEXT_PUBLIC_GOOGLE_VERIFICATION }
      : undefined,
    category: "safety equipment",
    openGraph: {
      type: "website",
      locale: "en_KE",
      url: siteUrl,
      siteName: "KimSafety",
      title: "KimSafety — Industrial & Medical Safety Equipment Supplier in Kenya",
      description: `Certified PPE, medical, fire, road and lab safety equipment. ${count} products, bulk discounts, same-day Nairobi delivery, corporate procurement support.`,
      images: [{ url: `${siteUrl}/og-image.jpg`, width: 1200, height: 630, alt: "KimSafety — Industrial & Medical Safety Equipment Supplier in Kenya" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "KimSafety — Industrial & Medical Safety Equipment Supplier in Kenya",
      description: `Certified PPE, medical, fire, road and lab safety equipment. ${count} products, bulk discounts, same-day Nairobi delivery.`,
      images: [`${siteUrl}/og-image.jpg`],
    },
    icons: {
      icon: "/images/logo/fav.jpeg",
      apple: "/images/logo/fav.jpeg",
    },
    manifest: "/manifest.webmanifest",
    robots: {
      index: true,
      follow: true,
      googleBot: { index: true, follow: true, "max-image-preview": "large", "max-video-preview": -1, "max-snippet": -1 },
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0F2847",
};

export const revalidate = 60;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Sequential to avoid 2 concurrent DB connections on cold Lambda (max:1).
  // Both helpers are cached (settings 60s, catalog 30s) so after first hit no DB.
  const brand = await loadBrand();
  const count = await productCount().catch(() => {
    const { products } = require("@/lib/data/products");
    return products.length;
  });

  const organizationJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${siteUrl}/#organization`,
    name: brand.site_name,
    url: siteUrl,
    logo: absoluteUrl(brand.logo),
    description:
      `Kenya's trusted marketplace for certified industrial PPE, medical safety, fire safety, road safety and laboratory equipment. ${count} products, 15 categories, 40+ authorized brands.`,
    email: brand.email,
    telephone: brand.phone,
    address: {
      "@type": "PostalAddress",
      streetAddress: "Industrial Area",
      addressLocality: "Nairobi",
      addressRegion: "Nairobi",
      postalCode: "00100",
      addressCountry: "KE",
    },
    contactPoint: [
      {
        "@type": "ContactPoint",
        telephone: brand.phone,
        contactType: "sales",
        availableLanguage: ["en"],
        areaServed: "KE",
      },
      {
        "@type": "ContactPoint",
        telephone: brand.phone,
        contactType: "customer service",
        availableLanguage: ["en"],
      },
    ],
    sameAs: [
      "https://facebook.com/kimsafetyltdke",
      "https://instagram.com/kimsafetyltdke",
      "https://linkedin.com/company/kimsafetyltdke",
      "https://youtube.com/@kimsafetyltdke",
    ],
    areaServed: { "@type": "Country", name: "Kenya" },
    foundingDate: "2019",
    slogan: "Protect Every Worker, Every Shift",
  };

  const websiteJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${siteUrl}/#website`,
    url: siteUrl,
    name: brand.site_name,
    publisher: { "@id": `${siteUrl}/#organization` },
    inLanguage: "en-KE",
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${siteUrl}/search?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };

  return (
    <html lang="en">
      <body className={`${inter.variable} ${jakarta.variable} font-sans antialiased`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
        />
        {(() => {
          const gaId = process.env.NEXT_PUBLIC_GA_ID || "G-3X3CZ6B428";
          return (
            <>
              <Script
                src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
                strategy="afterInteractive"
              />
              <Script id="ga-init" strategy="afterInteractive">
                {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${gaId}');`}
              </Script>
            </>
          );
        })()}
        <StoreProvider>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-xl focus:bg-navy-900 focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-white"
          >
            Skip to main content
          </a>
          <StorefrontChrome>{children}</StorefrontChrome>
        </StoreProvider>
      </body>
    </html>
  );
}