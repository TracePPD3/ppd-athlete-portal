import "./globals.css";
import Link from "next/link";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

export const metadata = {
  title: "PPD Athlete Portal",
  description: "Pure Player Development — training tools for athletes.",
  applicationName: "PPD Athlete Portal",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "PPD Portal",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0b0f",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <ServiceWorkerRegister />
        <header className="portal-header">
          <div className="wrap">
            <div className="badge">PPD</div>
            <Link href="/" className="name">
              Athlete Portal
            </Link>
            <div className="spacer" />
            <Link href="/" className="home-link">
              Home
            </Link>
          </div>
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
