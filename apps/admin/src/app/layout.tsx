import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'Green City SEZ · Reel Operations',
  description: 'Read-only Instagram Reels automation operations dashboard.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
