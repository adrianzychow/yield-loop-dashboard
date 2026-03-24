import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Yield Loop Dashboard",
  description: "On-chain looping strategies for yield-bearing assets",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen">{children}</body>
    </html>
  );
}
