"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import { createListingAction } from "@/app/app/listings/actions";
import { listingSchema, type ListingInput } from "@/lib/validation/listing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in local time. */
function localInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * A blank form: empty text, and a pickup window starting on the next hour.
 *
 * Returns the *field names* rather than `{ start, end }` on purpose. Spreading a
 * differently-shaped object into `form.reset()` type-checks — `reset` takes a
 * `DeepPartial` and object spread turns off excess-property checking — and then
 * silently blanks the pickup inputs instead of refilling them.
 */
function blankListing(): ListingInput {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const end = new Date(start);
  end.setHours(end.getHours() + 4);
  return {
    title: "",
    quantity: "",
    notes: "",
    pickupStart: localInputValue(start),
    pickupEnd: localInputValue(end),
  };
}

export function ListingForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const [defaults] = useState(blankListing);

  const form = useForm<ListingInput>({
    resolver: zodResolver(listingSchema),
    defaultValues: defaults,
  });

  function onSubmit(values: ListingInput) {
    setFormError(null);
    startTransition(async () => {
      const result = await createListingAction(values);
      if (result.ok) {
        toast.success("Listing posted.");
        form.reset(blankListing());
        router.refresh();
        return;
      }
      setFormError(result.message);
      for (const [field, messages] of Object.entries(
        result.fieldErrors ?? {},
      )) {
        if (messages?.[0]) {
          form.setError(field as keyof ListingInput, { message: messages[0] });
        }
      }
      toast.error(result.message);
    });
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="grid gap-4"
        noValidate
      >
        {formError ? (
          <p
            role="alert"
            className="bg-destructive/10 text-destructive rounded-lg px-3 py-2 text-sm"
          >
            {formError}
          </p>
        ) : null}

        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>What are you offering?</FormLabel>
              <FormControl>
                <Input
                  placeholder="Prepared sandwiches and salads"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="quantity"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Roughly how much?</FormLabel>
              <FormControl>
                <Input placeholder="About 40 portions, 3 crates" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="pickupStart"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Pickup from</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="pickupEnd"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Pickup until</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notes</FormLabel>
              <FormControl>
                <Textarea
                  rows={3}
                  placeholder="Where to collect, refrigeration, who to ask for…"
                  {...field}
                />
              </FormControl>
              <FormDescription>Optional.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" className="w-fit" disabled={isPending}>
          {isPending ? "Posting…" : "Post listing"}
        </Button>
      </form>
    </Form>
  );
}
