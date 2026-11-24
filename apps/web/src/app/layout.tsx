import type { Metadata } from 'next';
import './globals.css';
import { FormValidationSync } from '@/components/FormValidationSync';

export const metadata: Metadata = {
  title: 'bhaJami — Sathya Sai Bhajans Jam Studio',
  description:
    'Dual-theme Sathya Sai Bhajans Studio with Sai Rhythms pitch/raga metadata, Tanpura Shruti box, local archive streaming, and moderated community lyrics corrections.',
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
