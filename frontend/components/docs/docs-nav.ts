export interface DocsNavItem {
  href: string;
  label: string;
}

export interface DocsNavGroup {
  title: string;
  items: DocsNavItem[];
}

/**
 * Left-nav structure for the /docs section, grouped by topic in the
 * same spirit as a typical payments-platform docs sidebar (Introduction /
 * Guides / API reference / Webhooks, etc.) — adapted to this app's own areas.
 */
export const DOCS_NAV: DocsNavGroup[] = [
  {
    title: "Introduction",
    items: [{ href: "/docs", label: "Overview & architecture" }],
  },
  {
    title: "Core payments",
    items: [
      { href: "/docs/payments", label: "Payments" },
      { href: "/docs/customers", label: "Customers" },
      { href: "/docs/adapters", label: "PSP adapters & declines" },
      { href: "/docs/checkout-sdk", label: "Checkout SDK" },
      { href: "/docs/reconciliation", label: "Reconciliation & ledger" },
    ],
  },
  {
    title: "Configuration",
    items: [
      { href: "/docs/checkout", label: "Checkout configurator" },
      { href: "/docs/workflows", label: "Workflows" },
      { href: "/docs/retries", label: "Retries & dunning" },
      { href: "/docs/plans", label: "Plans & billing" },
      { href: "/docs/integrations", label: "Integrations" },
      { href: "/docs/team", label: "Team & invites" },
    ],
  },
  {
    title: "Risk & operations",
    items: [
      { href: "/docs/risk-monitoring", label: "Risk monitoring" },
      { href: "/docs/deployment", label: "Deployment" },
    ],
  },
];
