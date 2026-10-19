import { API_ENDPOINTS, type HttpMethod } from "@/lib/api-reference";

export interface DocsNavItem {
  href: string;
  label: string;
  method?: HttpMethod;
}

export interface DocsNavGroup {
  title: string;
  items: DocsNavItem[];
}

export type DocsSection = "guides" | "api";

export const GUIDES_NAV: DocsNavGroup[] = [
  {
    title: "Get started",
    items: [
      { href: "/docs", label: "Overview" },
      { href: "/docs/quickstart", label: "Quickstart" },
    ],
  },
  {
    title: "Accept payments",
    items: [
      { href: "/docs/payments", label: "Payment lifecycle" },
      { href: "/docs/customers", label: "Customers" },
      { href: "/docs/checkout-sdk", label: "Checkout SDK" },
      { href: "/docs/checkout", label: "Checkout configurator" },
      { href: "/docs/webhooks", label: "Webhooks" },
    ],
  },
  {
    title: "Optimize",
    items: [
      { href: "/docs/workflows", label: "Workflows" },
      { href: "/docs/retries", label: "Retries & dunning" },
      { href: "/docs/plans", label: "Plans & billing" },
    ],
  },
  {
    title: "Connect",
    items: [
      { href: "/docs/integrations", label: "Integrations" },
      { href: "/docs/adapters", label: "Processors & declines" },
      { href: "/docs/ai-agents", label: "AI agents (MCP)" },
    ],
  },
  {
    title: "Operate",
    items: [
      { href: "/docs/reconciliation", label: "Reconciliation & ledger" },
      { href: "/docs/risk-monitoring", label: "Risk monitoring" },
      { href: "/docs/team", label: "Team & invites" },
      { href: "/docs/deployment", label: "Deployment" },
    ],
  },
];

const endpointGroups = [...new Set(API_ENDPOINTS.map((endpoint) => endpoint.group))];

export const API_NAV: DocsNavGroup[] = [
  {
    title: "Basics",
    items: [
      { href: "/docs/api", label: "Introduction" },
      { href: "/docs/api#authentication", label: "Authentication & scopes" },
      { href: "/docs/api#idempotency", label: "Idempotency" },
      { href: "/docs/api#errors", label: "Errors" },
      { href: "/docs/api#pagination", label: "Pagination" },
    ],
  },
  ...endpointGroups.map((group) => ({
    title: group,
    items: API_ENDPOINTS.filter((endpoint) => endpoint.group === group).map((endpoint) => ({
      href: `/docs/api/${endpoint.slug}`,
      label: endpoint.title,
      method: endpoint.method,
    })),
  })),
];

export function sectionFor(pathname: string): DocsSection {
  return pathname === "/docs/api" || pathname.startsWith("/docs/api/") ? "api" : "guides";
}
