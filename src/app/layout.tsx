import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

const appUrl = process.env.NEXT_PUBLIC_APP_URL;

export const metadata: Metadata = {
  title: "Grounded Biographer",
  description:
    "Upload pages about one person and get a biography in which every sentence is traced to a source chunk, plus a full audit log.",
  ...(appUrl ? { metadataBase: new URL(appUrl) } : {}),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="container">
            <Link href="/" className="brand">
              Grounded <span>Biographer</span>
            </Link>
            <nav>
              <Link href="/">Home</Link>
              <Link href="/about">How it works</Link>
            </nav>
          </div>
        </header>
        <main>
          <div className="container">{children}</div>
        </main>
        <footer>
          <div className="container">
            Every sentence in a story is generated only from retrieved snippets and audited against them. Uploaded
            documents are private to their workspace link.
          </div>
        </footer>
      </body>
    </html>
  );
}
