import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { MotionProvider } from "@/components/motion/motion-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/** Editorial display serif — the studio's typographic voice. */
const fraunces = Fraunces({
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "FrameFlow — Photo delivery for photography teams",
    template: "%s · FrameFlow",
  },
  description:
    "Upload together, curate fast, and deliver private, PIN-protected galleries your clients will love.",
};

export const viewport: Viewport = {
  themeColor: "#faf9f6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ClerkProvider proxyUrl="/__clerk">
          <MotionProvider>
            <ThemeProvider>{children}</ThemeProvider>
            <Toaster position="bottom-right" />
          </MotionProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
