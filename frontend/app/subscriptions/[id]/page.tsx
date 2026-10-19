import { redirect } from "next/navigation";

export default function SubscriptionDetailRedirect() {
  redirect("/plans");
}
