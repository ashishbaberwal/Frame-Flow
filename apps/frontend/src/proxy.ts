import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)"]);

export default clerkMiddleware(
  async (auth, req) => {
    if (isProtectedRoute(req)) {
      await auth.protect();
    }
  },
  {
    // Clerk's production app proxy routes browser SDK requests through this
    // Next.js proxy path. Without this option, /__clerk/* returns 404 and the
    // SignIn/SignUp components remain blank even when the publishable key is
    // present in the Vercel build.
    frontendApiProxy: { enabled: true },
  },
);

export const config = {
  matcher: [
    // Skip Next.js internals and common static file extensions.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
    // Always run for Clerk's Frontend API proxy.
    "/__clerk/(.*)",
  ],
};
