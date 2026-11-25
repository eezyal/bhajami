import type { Metadata, Viewport } from 'next';
import './globals.css';
import { FormValidationSync } from '@/components/FormValidationSync';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fdf8f0' },
    { media: '(prefers-color-scheme: dark)', color: '#14100e' },
  ],
};

export const metadata: Metadata = {
  title: 'bhaJami — Sathya Sai Bhajans Jam Studio',
  description:
    'Dual-theme Sathya Sai Bhajans Studio with continuous Bhajan Stream radio, login-synced Liked playlist, Raga recommendations, and Tanpura Shruti box.',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'bhaJami',
    statusBarStyle: 'default',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script
          dangerouslySetInnerHTML={{
            __html: `try{document.querySelector('meta[name="color-scheme"]').content=localStorage.getItem("color-scheme")??"light dark";}catch{}`,
          }}
        />
      </head>
      <body>
        <FormValidationSync />
        {children}
      </body>
    </html>
  );
}
