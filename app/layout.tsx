import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Магнит рядом — заказ с телефона",
  description: "Телефонный браузер и MCP-инструменты для официального сайта Магнит.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="antialiased">{children}</body>
    </html>
  );
}
