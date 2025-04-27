"use client";

import { useState, useTransition } from "react";
import { MapPinIcon } from "lucide-react";

import { searchAddressAction } from "@/app/app/organization/actions";
import type { GeocodeResult } from "@/lib/geocode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function AddressSearchDialog({
  triggerLabel,
  onSelect,
}: {
  triggerLabel: string;
  onSelect: (result: GeocodeResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [isPending, startTransition] = useTransition();

  function runSearch() {
    setError(null);
    startTransition(async () => {
      const res = await searchAddressAction(query);
      setSearched(true);
      if (res.ok) {
        setResults(res.results);
      } else {
        setResults([]);
        setError(res.message);
      }
    });
  }

  function reset() {
    setQuery("");
    setResults([]);
    setError(null);
    setSearched(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <MapPinIcon />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Search for your address</DialogTitle>
          <DialogDescription>
            Type an address, then pick the closest match. The coordinates come
            from the result &mdash; they&rsquo;re never typed by hand.
          </DialogDescription>
        </DialogHeader>

        {/*
          `stopPropagation` is load-bearing, not defensive.

          Radix portals this dialog to <body>, so in the DOM it is not nested
          inside the organization form. But React's synthetic events bubble
          through the *React* tree, where this dialog is still a child of that
          form — so without this, pressing Search submits the organization form
          with whatever was in it, which reported "Organization updated" and
          redirected the user away mid-search. Regression test in
          organization-form.test.tsx.
        */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            runSearch();
          }}
          className="flex gap-2"
        >
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="123 Main St, Springfield"
            aria-label="Address to search"
          />
          <Button type="submit" disabled={isPending || query.trim().length < 3}>
            {isPending ? "Searching…" : "Search"}
          </Button>
        </form>

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        {searched && !error && results.length === 0 && !isPending ? (
          <p className="text-muted-foreground text-sm">
            No matches. Try adding a city or postal code.
          </p>
        ) : null}

        {results.length > 0 ? (
          <ul className="divide-border border-border max-h-64 divide-y overflow-y-auto rounded-lg border">
            {results.map((result) => (
              <li key={`${result.latitude},${result.longitude}`}>
                <button
                  type="button"
                  className="hover:bg-muted focus-visible:bg-muted w-full px-3 py-2 text-left text-sm focus-visible:outline-none"
                  onClick={() => {
                    onSelect(result);
                    setOpen(false);
                    reset();
                  }}
                >
                  {result.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
