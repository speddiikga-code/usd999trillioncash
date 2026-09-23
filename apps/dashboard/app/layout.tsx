import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { Shell } from '@/components/shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'ROOS — Revenue Opportunity OS',
  description: 'Discover, validate, launch and measure legitimate revenue opportunities — with human approval gates.',
};

// Apply the saved theme before first paint (avoids a flash of the wrong theme).
const themeScript = `try{var t=localStorage.getItem('roos_theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
