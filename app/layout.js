import './globals.css';

export const metadata = {
  title: 'NawaBus Scanner',
  description: 'Scanner de embarque NawaBus',
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt">
      <body>{children}</body>
    </html>
  );
}
