import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-24">
      <p className="text-brand text-sm font-medium tracking-wide uppercase">
        Food For Everyone
      </p>
      <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
        Connecting food donors with the people who can use it.
      </h1>
      <p className="text-muted-foreground text-lg text-pretty">
        Restaurants, grocers, and farms with surplus food find nearby food
        banks, shelters, and community fridges on a shared map — and coordinate
        the hand-off directly.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button disabled>Register your organization</Button>
        <Button variant="outline" disabled>
          Sign in
        </Button>
      </div>
      <p className="text-muted-foreground text-sm">
        Scaffold (M0). Auth, organization profiles, and the map arrive in
        M1&ndash;M3; this page is redesigned in M4.
      </p>
    </main>
  );
}
