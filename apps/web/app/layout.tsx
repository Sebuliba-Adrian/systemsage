import type { ReactNode } from 'react';

export const metadata = {
  title: 'SystemSage',
  description: 'Describe a system. Watch it get built, one real measured step at a time.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#0b0f19', color: '#e6e9f0' }}>
        {children}
      </body>
    </html>
  );
}
