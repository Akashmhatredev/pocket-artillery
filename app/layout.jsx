import './globals.css'; // Global styles

export const metadata = {
  title: 'Pocket Artillery',
  description: 'A modern, premium-quality multiplayer artillery battle game inspired by classic tank games.',
};

export default function RootLayout({children}) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
