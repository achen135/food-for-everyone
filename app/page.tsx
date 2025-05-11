import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  CircleCheckIcon,
  CirclePlayIcon,
  MapPinIcon,
  Share2Icon,
  UserPlusIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  description:
    "Register your organization, drop a pin, and connect with nearby food donors or recipients directly — no fees, no middleman. Free for donors and recipients.",
};

const HOW_IT_WORKS = [
  {
    icon: UserPlusIcon,
    title: "Register and choose your role",
    body: "Sign up as a food donor or a recipient organization. It takes a minute and costs nothing.",
  },
  {
    icon: MapPinIcon,
    title: "Set your location",
    body: "Search your address and confirm the pin. Your organization appears on the shared map right away.",
  },
  {
    icon: Share2Icon,
    title: "Connect with neighbors",
    body: "Donors see nearby recipients; recipients see nearby donors. Reach out with the contact details on each listing.",
  },
] as const;

const DONOR_POINTS = [
  "Find recipients within a few miles, not a few counties.",
  "Skip the phone tree — see who's active and what they accept.",
  "Keep edible food out of the dumpster and the landfill.",
] as const;

const RECIPIENT_POINTS = [
  "Discover local donors you didn't know were there.",
  "Plan pickups around your capacity and your hours.",
  "Build direct relationships with the businesses around you.",
] as const;

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <HowItWorks />
        <TwoSided />
        <ClosingCta />
      </main>
      <SiteFooter />
    </>
  );
}

// ------------------------------------------------------------------- nav

function SiteHeader() {
  return (
    <header className="border-border border-b">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-4 sm:px-10">
        <Link href="/" className="flex items-center gap-2.5">
          <BrandMark className="text-brand size-6" />
          <span className="font-heading text-lg font-semibold tracking-tight">
            Food For Everyone
          </span>
        </Link>
        <nav className="hidden items-center gap-8 text-sm font-medium md:flex">
          <a href="#how-it-works" className="hover:text-brand">
            How it works
          </a>
          <a href="#for-donors" className="hover:text-brand">
            For donors
          </a>
          <a href="#for-food-banks" className="hover:text-brand">
            For food banks
          </a>
          <a
            href="https://github.com/achen135/food-for-everyone"
            className="hover:text-brand"
          >
            About
          </a>
        </nav>
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm" className="hidden sm:flex">
            <Link href="/sign-in">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/sign-up">Register</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------- hero

function Hero() {
  return (
    <section className="mx-auto grid w-full max-w-6xl gap-14 px-6 py-16 sm:px-10 sm:py-20 lg:grid-cols-2 lg:items-center lg:py-24">
      <div className="flex max-w-xl flex-col gap-6">
        <span className="text-brand text-sm font-semibold tracking-wide uppercase">
          Local food rescue, mapped
        </span>
        <h1 className="text-4xl font-medium text-balance sm:text-5xl lg:text-[3.5rem] lg:leading-[1.08]">
          Good food finds a home when everyone&rsquo;s on the same map.
        </h1>
        <p className="text-muted-foreground text-lg text-pretty">
          Food For Everyone connects restaurants, grocers and farms with the
          food banks, shelters and community fridges around them. Register your
          organization, drop a pin, and coordinate donations directly — no fees,
          no middleman.
        </p>
        <div className="flex flex-wrap items-center gap-5 pt-1">
          <Button asChild size="lg" className="h-11 gap-2 px-6 text-[15px]">
            <Link href="/sign-up">
              Register your organization
              <ArrowRightIcon className="size-4.5" />
            </Link>
          </Button>
          <a
            href="#how-it-works"
            className="text-brand hover:text-brand-hover inline-flex items-center gap-2 text-[15px] font-semibold"
          >
            <CirclePlayIcon className="size-[18px]" />
            See how it works
          </a>
        </div>
        <p className="text-muted-foreground text-sm">
          Free for donors and recipients. Built for neighborhood food networks.{" "}
          <Link
            href="/sign-in?demo=1"
            className="text-brand font-medium hover:underline"
          >
            View a live demo
          </Link>
          .
        </p>
      </div>
      <MapIllustration className="border-border overflow-hidden rounded-2xl border shadow-[0_18px_40px_-24px_rgba(26,43,34,0.28)]" />
    </section>
  );
}

/** Decorative — a real map is what's behind the auth wall. */
function MapIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 620 462"
      role="img"
      aria-label="Illustration of a city map with donor and recipient pins"
      className={className}
    >
      <rect width="620" height="462" fill="#EFF4EC" />
      <path
        d="M-20 120 H640"
        stroke="#DCE6D6"
        strokeWidth="12"
        strokeLinecap="round"
      />
      <path
        d="M-20 300 H640"
        stroke="#DCE6D6"
        strokeWidth="18"
        strokeLinecap="round"
      />
      <path
        d="M140 -20 V500"
        stroke="#DCE6D6"
        strokeWidth="12"
        strokeLinecap="round"
      />
      <path
        d="M420 -20 V500"
        stroke="#DCE6D6"
        strokeWidth="16"
        strokeLinecap="round"
      />
      <path
        d="M-20 210 L200 210 L260 150 L640 150"
        stroke="#DCE6D6"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <path
        d="M300 500 L300 360 L500 360 L560 300"
        stroke="#DCE6D6"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <path
        d="M470 330 C520 330 560 360 590 410 C598 424 604 452 604 470 L470 470 Z"
        fill="#DBEBCF"
      />
      <path
        d="M40 350 q60 -40 130 -20 q40 40 -10 90 q-90 20 -120 -70Z"
        fill="#D6E7EC"
      />
      <path
        d="M214 214 C 270 250, 330 250, 372 300"
        stroke="#93A29A"
        strokeWidth="2"
        strokeDasharray="1 7"
        strokeLinecap="round"
      />
      <MapPin x={196} y={178} size="lg" color="#E8A33D" />
      <MapPin x={354} y={264} size="lg" color="#1F6E43" halo />
      <MapPin x={96} y={236} size="sm" color="#1F6E43" />
      <MapPin x={470} y={120} size="sm" color="#E8A33D" />
      <MapPin x={300} y={380} size="sm" color="#1F6E43" />
      <MapPin x={520} y={250} size="sm" color="#E8A33D" />
      <g transform="translate(32,384)">
        <rect width="176" height="62" rx="12" fill="#FFFFFF" />
        <rect
          x="0.5"
          y="0.5"
          width="175"
          height="61"
          rx="11.5"
          stroke="#E4E7E2"
        />
        <circle cx="22" cy="22" r="6" fill="#E8A33D" />
        <text x="38" y="27" fontSize="13" fontWeight="600" fill="#1A2B22">
          Food donors
        </text>
        <circle cx="22" cy="42" r="6" fill="#1F6E43" />
        <text x="38" y="47" fontSize="13" fontWeight="600" fill="#1A2B22">
          Recipients
        </text>
      </g>
    </svg>
  );
}

/**
 * Two fixed sizes, not a computed scale — the pin's path data is a hand-drawn
 * teardrop, and interpolating it by an arbitrary radius produced malformed
 * `d` strings (mashed-together numbers with no separator). Paths below are
 * the mockup's exact large/small variants.
 */
const PIN_PATH: Record<"lg" | "sm", { d: string; r: number; dotR: number }> = {
  lg: {
    d: "M14 1.5c-6.9 0-12.5 5.6-12.5 12.5 0 8.9 10.8 21.7 11.8 22.8a.9.9 0 0 0 1.4 0C16.7 35.7 27.5 22.9 27.5 14 27.5 7.1 21.9 1.5 15 1.5Z",
    r: 14,
    dotR: 5,
  },
  sm: {
    d: "M12 1.5c-5.8 0-10.5 4.7-10.5 10.5 0 7.4 9 18.1 9.8 19a.8.8 0 0 0 1.2 0c.8-.9 9.8-11.6 9.8-19C22.5 6.2 17.8 1.5 12 1.5Z",
    r: 12,
    dotR: 4.2,
  },
};

function MapPin({
  x,
  y,
  size,
  color,
  halo = false,
}: {
  x: number;
  y: number;
  size: "lg" | "sm";
  color: string;
  halo?: boolean;
}) {
  const { d, r, dotR } = PIN_PATH[size];
  return (
    <g transform={`translate(${x - r},${y - r})`}>
      <ellipse
        cx={r}
        cy={r * 2.86}
        rx={r * 0.71}
        ry={r * 0.25}
        fill="#1A2B22"
        opacity="0.13"
      />
      {halo ? (
        <circle cx={r} cy={r} r={r * 1.86} fill={color} opacity="0.12" />
      ) : null}
      <path d={d} fill={color} />
      <circle cx={r} cy={r} r={dotR} fill="#FFFFFF" />
    </g>
  );
}

function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M14 1.5c-4.7 0-8.5 3.8-8.5 8.5 0 6 7.4 14.7 8 15.4a.7.7 0 0 0 1 0c.6-.7 8-9.4 8-15.4 0-4.7-3.8-8.5-8.5-8.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

// ---------------------------------------------------------- how it works

function HowItWorks() {
  return (
    <section id="how-it-works" className="bg-secondary/60 py-20 sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-6 sm:px-10">
        <div className="mx-auto mb-12 flex max-w-xl flex-col items-center gap-3 text-center">
          <span className="text-brand text-sm font-semibold tracking-wide uppercase">
            How it works
          </span>
          <h2 className="text-3xl font-medium sm:text-4xl">
            From surplus to served, in three steps
          </h2>
        </div>
        <div className="grid gap-7 sm:grid-cols-3">
          {HOW_IT_WORKS.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="border-border bg-card flex flex-col gap-3.5 rounded-2xl border p-7"
            >
              <span className="bg-brand/10 text-brand flex size-11 items-center justify-center rounded-xl">
                <Icon className="size-5.5" />
              </span>
              <h3 className="text-lg font-semibold">{title}</h3>
              <p className="text-muted-foreground text-[15px]">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- both sides

function TwoSided() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-20 sm:px-10 sm:py-24">
      <div className="mx-auto mb-11 flex max-w-xl flex-col items-center gap-3 text-center">
        <span className="text-brand text-sm font-semibold tracking-wide uppercase">
          Two sides, one handoff
        </span>
        <h2 className="text-3xl font-medium sm:text-4xl">
          Built for both ends of the donation
        </h2>
      </div>
      <div className="grid gap-8 md:grid-cols-2">
        <ValueCard
          id="for-donors"
          eyebrow="For food donors"
          eyebrowClassName="text-brand-amber"
          title="Move surplus before it spoils"
          points={DONOR_POINTS}
        />
        <ValueCard
          id="for-food-banks"
          eyebrow="For food banks & shelters"
          title="See what's available nearby"
          points={RECIPIENT_POINTS}
          tinted
        />
      </div>
    </section>
  );
}

function ValueCard({
  id,
  eyebrow,
  eyebrowClassName,
  title,
  points,
  tinted = false,
}: {
  id: string;
  eyebrow: string;
  eyebrowClassName?: string;
  title: string;
  points: readonly string[];
  tinted?: boolean;
}) {
  return (
    <div
      id={id}
      className={`border-border flex scroll-mt-20 flex-col gap-5 rounded-2xl border p-9 ${tinted ? "bg-secondary/60" : ""}`}
    >
      <span
        className={`text-sm font-semibold tracking-wide uppercase ${eyebrowClassName ?? "text-brand"}`}
      >
        {eyebrow}
      </span>
      <h3 className="text-2xl font-semibold">{title}</h3>
      <ul className="flex flex-col gap-3.5">
        {points.map((point) => (
          <li key={point} className="flex items-start gap-3">
            <CircleCheckIcon className="text-brand mt-0.5 size-5 shrink-0" />
            <p className="text-muted-foreground text-[15px]">{point}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// -------------------------------------------------------------- closing cta

function ClosingCta() {
  return (
    <section className="px-6 py-20 text-center sm:py-24">
      <div className="mx-auto flex max-w-xl flex-col items-center gap-5">
        <h2 className="text-3xl font-medium sm:text-4xl">
          Ready to put your organization on the map?
        </h2>
        <p className="text-muted-foreground text-lg text-pretty">
          Registration is free for donors and recipients alike. Add your
          organization today and start seeing who&rsquo;s nearby.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-5 pt-1">
          <Button asChild size="lg" className="h-11 gap-2 px-6 text-[15px]">
            <Link href="/sign-up">
              Register your organization
              <ArrowRightIcon className="size-4.5" />
            </Link>
          </Button>
          <a
            href="mailto:hello@foodforeveryone.invalid"
            className="text-brand hover:text-brand-hover text-[15px] font-semibold"
          >
            Have questions? Email the team
          </a>
        </div>
      </div>
    </section>
  );
}

// -------------------------------------------------------------------- footer

function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="bg-foreground text-background/85">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap justify-between gap-12 px-6 py-14 sm:px-10">
        <div className="flex max-w-xs flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <BrandMark className="text-brand-support size-6" />
            <span className="font-heading text-background text-lg font-semibold">
              Food For Everyone
            </span>
          </div>
          <p className="text-background/60 text-sm">
            A shared map for neighborhood food rescue.
          </p>
        </div>
        <div className="flex flex-wrap gap-16">
          <div className="flex flex-col gap-2.5">
            <span className="text-background/50 text-xs font-bold tracking-wide uppercase">
              Product
            </span>
            <a href="#how-it-works" className="text-background/80 text-sm">
              How it works
            </a>
            <a href="#for-donors" className="text-background/80 text-sm">
              For donors
            </a>
            <a href="#for-food-banks" className="text-background/80 text-sm">
              For food banks
            </a>
          </div>
          <div className="flex flex-col gap-2.5">
            <span className="text-background/50 text-xs font-bold tracking-wide uppercase">
              Project
            </span>
            <a
              href="https://github.com/achen135/food-for-everyone"
              className="text-background/80 text-sm"
            >
              GitHub
            </a>
            <Link href="/sign-in?demo=1" className="text-background/80 text-sm">
              Live demo
            </Link>
            <a
              href="mailto:hello@foodforeveryone.invalid"
              className="text-background/80 text-sm"
            >
              Contact
            </a>
          </div>
        </div>
      </div>
      <div className="border-background/10 mx-auto flex w-full max-w-6xl flex-wrap justify-between gap-6 border-t px-6 py-5 text-xs sm:px-10">
        <span className="text-background/50">
          © {year} Food For Everyone · A portfolio project by Alex Chen
        </span>
        <span className="text-background/50">
          Map data © OpenStreetMap contributors
        </span>
      </div>
    </footer>
  );
}
