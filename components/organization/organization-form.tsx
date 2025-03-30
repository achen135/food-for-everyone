"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import { saveOrganizationAction } from "@/app/app/organization/actions";
import type { Organization } from "@/lib/db";
import {
  organizationSchema,
  type OrganizationInput,
} from "@/lib/validation/organization";
import { AddressSearchDialog } from "@/components/organization/address-search-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const TYPE_OPTIONS = [
  {
    value: "donor",
    title: "We donate food",
    hint: "A restaurant, grocer, or farm with surplus food to give.",
  },
  {
    value: "recipient",
    title: "We receive food",
    hint: "A food bank, shelter, or community fridge that receives food.",
  },
] as const;

export function OrganizationForm({
  initial,
}: {
  initial: Organization | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<OrganizationInput>({
    resolver: zodResolver(organizationSchema),
    defaultValues: {
      name: initial?.name ?? "",
      type: initial?.type,
      description: initial?.description ?? "",
      email: initial?.email ?? "",
      phone: initial?.phone ?? "",
      website: initial?.website ?? "",
      address: initial?.address ?? "",
      latitude: null,
      longitude: null,
    },
  });

  const address = useWatch({ control: form.control, name: "address" });

  function onSubmit(values: OrganizationInput) {
    setFormError(null);
    startTransition(async () => {
      const result = await saveOrganizationAction(values);
      if (result.ok) {
        toast.success(
          initial ? "Organization updated." : "Organization created.",
        );
        router.push("/app");
        router.refresh();
        return;
      }
      setFormError(result.message);
      for (const [field, messages] of Object.entries(
        result.fieldErrors ?? {},
      )) {
        if (messages?.[0]) {
          form.setError(field as keyof OrganizationInput, {
            message: messages[0],
          });
        }
      }
      toast.error(result.message);
    });
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="grid max-w-xl gap-6"
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
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Organization name</FormLabel>
              <FormControl>
                <Input placeholder="Springfield Community Kitchen" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Which side are you?</FormLabel>
              <FormControl>
                <RadioGroup
                  onValueChange={field.onChange}
                  value={field.value ?? ""}
                  className="gap-3"
                >
                  {TYPE_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className="border-border has-data-checked:border-primary has-data-checked:bg-secondary flex cursor-pointer items-start gap-3 rounded-lg border p-3"
                    >
                      <RadioGroupItem value={option.value} className="mt-0.5" />
                      <span className="grid gap-0.5">
                        <span className="text-sm font-medium">
                          {option.title}
                        </span>
                        <span className="text-muted-foreground text-sm">
                          {option.hint}
                        </span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea
                  rows={4}
                  placeholder="What you offer or need, hours, pickup notes…"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Shown to counterparties on the map. Optional.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <fieldset className="grid gap-4">
          <legend className="text-sm font-medium">Contact</legend>
          <p className="text-muted-foreground -mt-2 text-sm">
            At least one of email or phone. Shown on the map; your login email
            is never shown.
          </p>

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    autoComplete="off"
                    placeholder="hello@organization.org"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Phone</FormLabel>
                <FormControl>
                  <Input type="tel" placeholder="(555) 123-4567" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="website"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Website</FormLabel>
                <FormControl>
                  <Input placeholder="organization.org" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </fieldset>

        <FormField
          control={form.control}
          name="address"
          render={() => (
            <FormItem>
              <FormLabel>Address</FormLabel>
              <div className="flex flex-wrap items-center gap-3">
                <p className="border-border text-muted-foreground min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm">
                  {address || "No address yet — search for one."}
                </p>
                <AddressSearchDialog
                  triggerLabel={address ? "Change address" : "Search address"}
                  onSelect={(result) => {
                    form.setValue("address", result.label, {
                      shouldValidate: true,
                    });
                    form.setValue("latitude", result.latitude);
                    form.setValue("longitude", result.longitude);
                  }}
                />
              </div>
              <FormDescription>
                Coordinates are derived from the search result, never typed.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex gap-3">
          <Button type="submit" disabled={isPending}>
            {isPending
              ? "Saving…"
              : initial
                ? "Save changes"
                : "Create organization"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push("/app")}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Form>
  );
}
