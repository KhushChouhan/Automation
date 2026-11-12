import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'Green City SEZ · Reel Operations',
  description: 'Authenticated Instagram Reels operations and approval dashboard.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <nav className="main-nav" aria-label="Main navigation">
          {[
            ['/', 'Overview'],
            ['/videos', 'Videos'],
            ['/approvals', 'Approvals'],
            ['/schedule', 'Schedule'],
            ['/failures', 'Failures'],
            ['/audit', 'Audit log'],
            ['/settings', 'Settings'],
          ].map(([href, name]) => (
            <a href={href} key={href}>
              {name}
            </a>
          ))}
        </nav>
        {children}
      </body>
    </html>
  );
}
