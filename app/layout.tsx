import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Магнит рядом — каталог с телефона",
  description: "Мобильный HTTP-каталог и MCP-поиск товаров Магнит.",
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
