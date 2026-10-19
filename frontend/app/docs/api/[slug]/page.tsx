import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EndpointView } from "@/components/docs/endpoint-view";
import { API_ENDPOINTS, findEndpoint } from "@/lib/api-reference";

export function generateStaticParams() {
  return API_ENDPOINTS.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const endpoint = findEndpoint(slug);
  return { title: endpoint ? `${endpoint.title} · Alpha Payments API` : "API reference" };
}

export default async function EndpointPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const index = API_ENDPOINTS.findIndex((endpoint) => endpoint.slug === slug);
  if (index === -1) notFound();
  return <EndpointView endpoint={API_ENDPOINTS[index]!} previous={API_ENDPOINTS[index - 1]} next={API_ENDPOINTS[index + 1]} />;
}
