"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  FolderClosed,
  Images,
  LockKeyhole,
  Menu,
  Sparkles,
  UploadCloud,
  X,
  Check,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { SignInButton, SignUpButton, Show } from "@clerk/nextjs";

const navLinks = [
  { label: "Product", href: "#features" },
  { label: "Features", href: "#features" },
  { label: "How it works", href: "#workflow" },
  { label: "Pricing", href: "#pricing" },
];

const features = [
  {
    icon: UploadCloud,
    title: "Collaborative uploads",
    body: "Every second shooter uploads into one shared pool. No more AirDrops, drives, or lost folders.",
  },
  {
    icon: Check,
    title: "Smart photo selection",
    body: "Flag keepers as a team, then hand clients a shortlist instead of a thousand raw frames.",
  },
  {
    icon: Images,
    title: "Private client galleries",
    body: "Curated collections with your studio's name on them — fast to build, beautiful to open.",
  },
  {
    icon: LockKeyhole,
    title: "Secure PIN access",
    body: "Galleries open only with the link and a 6-digit PIN. Set an expiry date and move on.",
  },
];

const workflow = [
  {
    step: "01",
    icon: FolderClosed,
    title: "Create event",
    body: "Set the date, venue, and team. Everyone sees one shared workspace for the shoot.",
  },
  {
    step: "02",
    icon: UploadCloud,
    title: "Upload together",
    body: "The whole crew drags photos into the same pool — tagged by photographer, sorted by time.",
  },
  {
    step: "03",
    icon: Check,
    title: "Curate",
    body: "Select keepers with a click or shift-range. What's selected is what ships.",
  },
  {
    step: "04",
    icon: Sparkles,
    title: "Share",
    body: "Publish a PIN-protected gallery. Copy the link, send the PIN, done before dinner.",
  },
];

const useCases = [
  { name: "Weddings", photo: "https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=800&q=80" },
  { name: "Corporate events", photo: "https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=800&q=80" },
  { name: "Concerts", photo: "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=800&q=80" },
  { name: "Sports", photo: "https://images.unsplash.com/photo-1459865264687-595d652de67e?auto=format&fit=crop&w=800&q=80" },
  { name: "Studios", photo: "https://images.unsplash.com/photo-1554048612-b6a482bc67e5?auto=format&fit=crop&w=800&q=80" },
];

export default function LandingPage() {
  const [menuOpen, setMenuOpen] = React.useState(false);

  return (
    <div className="min-h-dvh">
      <SiteHeader menuOpen={menuOpen} setMenuOpen={setMenuOpen} />

      {/* Hero */}
      <section className="relative overflow-hidden border-b">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-14 md:px-6 lg:grid-cols-2 lg:pb-24 lg:pt-20">
          <div className="animate-fade-up">
            <h1 className="font-display text-4xl font-semibold leading-[1.08] tracking-tight text-balance sm:text-5xl lg:text-[3.4rem]">
              From thousands of photos to the perfect gallery.
            </h1>
            <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground sm:text-lg">
              FrameFlow is where photography teams upload together, curate in minutes, and deliver
              private, PIN-protected galleries their clients actually open.
            </p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Button size="lg" asChild>
                <Link href="/register">Create your first event</Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/login">Sign in</Link>
              </Button>
            </div>
            <p className="mt-5 text-sm text-muted-foreground">
              Free for your first event · No card required
            </p>
          </div>

          {/* Hero composition */}
          <div className="relative animate-fade-up [animation-delay:120ms]" aria-hidden="true">
            <div className="overflow-hidden rounded-2xl border bg-card shadow-xl">
              {/* fake app header */}
              <div className="flex items-center gap-2 border-b px-4 py-2.5">
                <span className="size-2.5 rounded-full bg-border" />
                <span className="size-2.5 rounded-full bg-border" />
                <span className="size-2.5 rounded-full bg-border" />
                <span className="ml-3 h-5 w-40 rounded-full bg-secondary" />
              </div>
              {/* fake stat row */}
              <div className="grid grid-cols-3 gap-3 border-b px-4 py-3">
                {[
                  ["Photos", "4,210"],
                  ["Team", "7"],
                  ["Galleries", "2"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
                    <p className="font-display text-base font-semibold tabular-nums">{value}</p>
                  </div>
                ))}
              </div>
              {/* fake grid */}
              <div className="grid grid-cols-4 gap-1.5 p-3">
                {heroThumbs.map((src, i) => (
                  <div
                    key={i}
                    className={cn(
                      "relative overflow-hidden rounded-md bg-secondary",
                      i === 3 || i === 8 ? "col-span-2 aspect-[2/1.05]" : "aspect-square"
                    )}
                  >
                    <Image
                      src={src}
                      alt=""
                      fill
                      sizes="(max-width: 640px) 25vw, 160px"
                      loading={i < 2 ? "eager" : "lazy"}
                      priority={i === 0}
                      className="object-cover"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* floating card: upload */}
            <div className="absolute -bottom-5 -left-3 hidden items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-lg sm:flex lg:-left-10">
              <span className="flex size-9 items-center justify-center rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                <Check className="size-4" />
              </span>
              <div>
                <p className="text-sm font-medium">128 photos uploaded</p>
                <p className="text-xs text-muted-foreground">Sarah · just now</p>
              </div>
            </div>

            {/* floating card: PIN */}
            <div className="absolute -top-5 right-2 hidden items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-lg md:flex lg:-right-6">
              <span className="flex size-9 items-center justify-center rounded-full bg-accent text-accent-foreground">
                <LockKeyhole className="size-4" />
              </span>
              <div>
                <p className="text-xs text-muted-foreground">Gallery PIN</p>
                <p className="font-mono text-sm font-semibold tracking-[0.25em]">••••••</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-b">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-6 lg:py-24">
          <h2 className="max-w-lg font-display text-3xl font-semibold tracking-tight text-balance">
            Everything between the camera and the client.
          </h2>
          <div className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((f) => (
              <div key={f.title}>
                <f.icon className="size-5 text-accent-foreground" aria-hidden="true" />
                <h3 className="mt-3.5 font-display text-base font-semibold">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section id="workflow" className="border-b bg-secondary/40">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-6 lg:py-24">
          <h2 className="max-w-lg font-display text-3xl font-semibold tracking-tight text-balance">
            Shoot on Saturday. Deliver by Sunday.
          </h2>
          <ol className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {workflow.map((w, i) => (
              <li key={w.step} className="relative">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-semibold text-accent-foreground">{w.step}</span>
                  {i < workflow.length - 1 && (
                    <span aria-hidden="true" className="hidden h-px flex-1 bg-border lg:block" />
                  )}
                </div>
                <h3 className="mt-3 font-display text-base font-semibold">{w.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{w.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Use cases */}
      <section className="border-b">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-6 lg:py-24">
          <h2 className="max-w-lg font-display text-3xl font-semibold tracking-tight text-balance">
            Built for the events you shoot.
          </h2>
          <ul className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {useCases.map((u) => (
              <li key={u.name} className="group relative overflow-hidden rounded-xl">
                <div className="relative aspect-[4/5]">
                  <Image
                    src={u.photo}
                    alt={`${u.name} photography`}
                    fill
                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 220px"
                    loading="lazy"
                    className="object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                </div>
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                <p className="absolute bottom-3 left-3 text-sm font-medium text-white">{u.name}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Pricing placeholder */}
      <section id="pricing" className="border-b bg-secondary/40">
        <div className="mx-auto max-w-6xl px-4 py-16 text-center md:px-6 lg:py-20">
          <h2 className="font-display text-3xl font-semibold tracking-tight">Simple, per-event pricing</h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
            Pay for the events you shoot, not the seats on your team. Full pricing arrives at launch.
          </p>
          <Button variant="outline" size="lg" className="mt-6" asChild>
            <Link href="/register">
              Join the waitlist <ArrowRight />
            </Link>
          </Button>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-b">
        <div className="mx-auto max-w-6xl px-4 py-20 text-center md:px-6 lg:py-28">
          <h2 className="mx-auto max-w-xl font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Ready to share the moments that matter?
          </h2>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" asChild>
              <Link href="/register">Create your first event</Link>
            </Button>
            <Button size="lg" variant="ghost" asChild>
              <Link href="/login">Log in</Link>
            </Button>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}

const heroThumbs = [
  "https://images.unsplash.com/photo-1519225421980-715cb0215aed?auto=format&fit=crop&w=400&q=80",
  "https://images.unsplash.com/photo-1606800052052-a08af7148866?auto=format&fit=crop&w=400&q=80",
  "https://images.unsplash.com/photo-1583939003579-730e3918a45a?auto=format&fit=crop&w=400&q=80",
  "https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=600&q=80",
  "https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?auto=format&fit=crop&w=400&q=80",
  "https://images.unsplash.com/photo-1537633552985-df8429e8048b?auto=format&fit=crop&w=400&q=80",
  "https://images.unsplash.com/photo-1591604466107-ec97de577aff?auto=format&fit=crop&w=400&q=80",
  "https://images.unsplash.com/photo-1529634806980-85c3dd6d34ac?auto=format&fit=crop&w=400&q=80",
  "https://images.unsplash.com/photo-1550005809-91ad75fb315f?auto=format&fit=crop&w=600&q=80",
  "https://images.unsplash.com/photo-1515934751635-c81c6bc9a2d8?auto=format&fit=crop&w=400&q=80",
  "https://images.unsplash.com/photo-1520854221256-17451cc331bf?auto=format&fit=crop&w=400&q=80",
];

function SiteHeader({
  menuOpen,
  setMenuOpen,
}: {
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
}) {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 md:px-6">
        <Logo />
        <nav className="hidden items-center gap-6 md:flex" aria-label="Main">
          {navLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto hidden items-center gap-2 md:flex">
          <Show when="signed-out">
            <Button variant="ghost" asChild>
              <SignInButton mode="redirect" fallbackRedirectUrl="/dashboard">
                Log in
              </SignInButton>
            </Button>
            <Button asChild>
              <SignUpButton mode="redirect" fallbackRedirectUrl="/dashboard">
                Get started
              </SignUpButton>
            </Button>
          </Show>
          <Show when="signed-in">
            <Button variant="ghost" asChild>
              <Link href="/dashboard">Dashboard</Link>
            </Button>
          </Show>
        </div>
        <button
          className="ml-auto rounded-md p-2 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden cursor-pointer"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
        >
          {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
      {menuOpen && (
        <div className="border-t bg-background px-4 pb-4 pt-2 md:hidden animate-fade-in">
          <nav className="grid" aria-label="Mobile">
            {navLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="rounded-md px-2 py-2.5 text-sm font-medium hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Show when="signed-out">
              <Button variant="outline" asChild>
                <SignInButton mode="redirect" fallbackRedirectUrl="/dashboard">
                  Log in
                </SignInButton>
              </Button>
              <Button asChild>
                <SignUpButton mode="redirect" fallbackRedirectUrl="/dashboard">
                  Get started
                </SignUpButton>
              </Button>
            </Show>
            <Show when="signed-in">
              <Button asChild>
                <Link href="/dashboard">Dashboard</Link>
              </Button>
            </Show>
          </div>
        </div>
      )}
    </header>
  );
}

function SiteFooter() {
  return (
    <footer>
      <div className="mx-auto max-w-6xl px-4 py-12 md:px-6">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Logo />
            <p className="mt-3 max-w-xs text-sm text-muted-foreground">
              The delivery workflow for photography teams — upload together, curate fast, share securely.
            </p>
          </div>
          <div>
            <h3 className="text-sm font-semibold">Product</h3>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li><a href="#features" className="hover:text-foreground">Features</a></li>
              <li><a href="#workflow" className="hover:text-foreground">How it works</a></li>
              <li><a href="#pricing" className="hover:text-foreground">Pricing</a></li>
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold">Use cases</h3>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>Weddings</li>
              <li>Corporate events</li>
              <li>Concerts &amp; sports</li>
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold">Company</h3>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li><Link href="/login" className="hover:text-foreground">Log in</Link></li>
              <li><Link href="/register" className="hover:text-foreground">Get started</Link></li>
              <li>hello@frameflow.app</li>
            </ul>
          </div>
        </div>
        <div className="mt-10 flex flex-col items-center justify-between gap-3 border-t pt-6 text-xs text-muted-foreground sm:flex-row">
          <p>© 2026 FrameFlow. All rights reserved.</p>
          <p>Made for the people behind the camera.</p>
        </div>
      </div>
    </footer>
  );
}
