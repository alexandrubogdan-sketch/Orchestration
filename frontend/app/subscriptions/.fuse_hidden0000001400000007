import { redirect } from "next/navigation";

/**
 * "Subscriptions" was renamed to "Plans" (catalog management, modeled on
 * docs.paynext.com/guides/platform/plans) — this route stays in place as
 * a redirect so any old links/bookmarks keep working. The delete tool
 * can't remove this file (outputs folder is append-only), so it's
 * overwritten to a redirect rather than left as dead code referencing
 * types that no longer exist.
 */
export default function SubscriptionsRedirect() {
  redirect("/plans");
}
